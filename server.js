// Edge — live odds comparison server
// Zero dependencies. Requires Node 18+ (global fetch).
//
// Proxies The Odds API (https://the-odds-api.com), keeps the API key on the
// server, and caches responses so every visitor shares the same upstream call.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDOOR_SPORTS, venueFor, placeGuesses, normalize as teamKey } from './venues.js';
import { loadNflEpa, loadCfbEpa, indexTeams } from './stats.js';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const API_BASE = (process.env.ODDS_API_BASE || 'https://api.the-odds-api.com').replace(/\/$/, '');
const REGIONS = process.env.ODDS_REGIONS || 'us,us2';
// How long to reuse odds before asking The Odds API again.
// Live games refresh fast (the API updates in-play odds ~every 40s);
// boards with no live games refresh slowly (pre-match odds update ~every 5 min).
const ODDS_TTL = (Number(process.env.CACHE_SECONDS) || 300) * 1000;
const LIVE_TTL = (Number(process.env.LIVE_CACHE_SECONDS) || 30) * 1000;
const SPORTS_TTL = 60 * 60 * 1000;

// Sports the site lists. Add or remove keys here (see GET /v4/sports for all keys).
const MAJOR_SPORTS = new Set([
  'americanfootball_nfl', 'americanfootball_ncaaf',
  'basketball_nba', 'basketball_ncaab', 'basketball_wnba',
  'baseball_mlb', 'icehockey_nhl',
  'soccer_epl', 'soccer_uefa_champs_league', 'soccer_usa_mls', 'soccer_spain_la_liga',
  'mma_mixed_martial_arts',
]);
const MARKETS = new Set(['h2h', 'spreads', 'totals']);

// Player props: fetched per game, one market at a time, only when someone opens them.
const PROPS_TTL = (Number(process.env.PROPS_CACHE_SECONDS) || 600) * 1000;
const PROPS_LIVE_TTL = (Number(process.env.PROPS_LIVE_CACHE_SECONDS) || 60) * 1000;
const FOOTBALL_PROPS = ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_pass_tds', 'player_anytime_td'];
const HOOPS_PROPS = ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists'];
const SOCCER_PROPS = ['player_goal_scorer_anytime', 'player_shots_on_target'];
const PROP_MARKETS = {
  americanfootball_nfl: FOOTBALL_PROPS, americanfootball_ncaaf: FOOTBALL_PROPS,
  basketball_nba: HOOPS_PROPS, basketball_ncaab: HOOPS_PROPS, basketball_wnba: HOOPS_PROPS,
  icehockey_nhl: ['player_points', 'player_shots_on_goal', 'player_goal_scorer_anytime', 'player_assists'],
  baseball_mlb: ['batter_hits', 'batter_home_runs', 'batter_total_bases', 'pitcher_strikeouts'],
  soccer_epl: SOCCER_PROPS, soccer_uefa_champs_league: SOCCER_PROPS, soccer_spain_la_liga: SOCCER_PROPS, soccer_usa_mls: SOCCER_PROPS,
};

const cache = new Map(); // key -> { at, body, inflight }

// Weather from Open-Meteo (https://open-meteo.com): free, no key. Check their terms before commercial use.
const WEATHER_BASE = (process.env.WEATHER_API_BASE || 'https://api.open-meteo.com').replace(/\/$/, '');
const WEATHER_TTL = 30 * 60 * 1000;
const GEOCODE_BASE = (process.env.GEOCODE_API_BASE || 'https://geocoding-api.open-meteo.com').replace(/\/$/, '');
const geocoded = new Map(); // team -> Promise<[lat, lon, 'outdoor'] | null>, kept for the life of the server
const US_SPORTS = new Set(['americanfootball_nfl', 'americanfootball_ncaaf', 'baseball_mlb', 'soccer_usa_mls']);

// Neutral-site games (bowls, playoffs, Army-Navy, NFL international games): the odds feed doesn't say where a game is played,
// so we check ESPN's public scoreboard, which lists each game's venue. If ESPN is unreachable we fall back to the home stadium.
const ESPN_BASE = (process.env.ESPN_API_BASE || 'https://site.api.espn.com').replace(/\/$/, '');
const ESPN_LEAGUES = {
  americanfootball_nfl: ['football/nfl', ['']],
  americanfootball_ncaaf: ['football/college-football', ['&groups=80', '&groups=81']], // FBS and FCS
  baseball_mlb: ['baseball/mlb', ['']],
  soccer_usa_mls: ['soccer/usa.1', ['']],
};
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

async function upstream(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries({ ...params, apiKey: API_KEY })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining != null) console.log(`[odds] ${path} — credits left: ${remaining}`);
  return {
    data: await res.json(),
    quota: {
      remaining: res.headers.get('x-requests-remaining'),
      used: res.headers.get('x-requests-used'),
    },
  };
}

// Cache with in-flight de-duplication: concurrent visitors trigger one upstream call.
// `ttl` is a number of ms, or a function (body) => ms so each response can pick its own lifetime.
async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit?.body && Date.now() - hit.at < hit.ttl) return hit.body;
  if (hit?.inflight) return hit.inflight;
  const inflight = loader()
    .then((body) => {
      cache.set(key, { at: Date.now(), body, ttl: typeof ttl === 'function' ? ttl(body) : ttl });
      return body;
    })
    .catch((e) => {
      // Serve stale data if we have it rather than failing the page.
      if (hit?.body) { cache.set(key, hit); return { ...hit.body, stale: true }; }
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...hit, inflight });
  return inflight;
}

// Hourly forecast for one venue (16 days ahead), cached for 30 minutes.
function forecast(lat, lon) {
  return cached(`wx:${lat},${lon}`, WEATHER_TTL, async () => {
    const url = new URL(WEATHER_BASE + '/v1/forecast');
    const params = {
      latitude: lat, longitude: lon, forecast_days: 16, timeformat: 'unixtime', timezone: 'GMT',
      hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather ${res.status}`);
    return (await res.json()).hourly;
  });
}

// Backup for teams missing from venues.js: look the team's city up with Open-Meteo's place search.
// Logged so the team can be added to venues.js properly (with its roof type).
function geocodeTeam(sport, team) {
  const key = `${sport}|${team}`;
  if (!geocoded.has(key)) {
    geocoded.set(key, (async () => {
      for (const name of placeGuesses(team).slice(0, 5)) {
        const url = new URL(GEOCODE_BASE + '/v1/search');
        url.searchParams.set('name', name); url.searchParams.set('count', '10'); url.searchParams.set('language', 'en');
        if (US_SPORTS.has(sport) && sport !== 'soccer_usa_mls') url.searchParams.set('countryCode', 'US');
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const place = ((await res.json()).results || [])
            .filter((r) => String(r.feature_code || '').startsWith('PPL') && (r.population || 0) >= 15000)
            .filter((r) => sport !== 'soccer_usa_mls' || ['US', 'CA'].includes(r.country_code))
            .sort((a, b) => (b.population || 0) - (a.population || 0))[0];
          if (place) {
            console.warn(`[weather] "${team}" (${sport}) isn't in venues.js; using ${place.name}, ${place.admin1 || place.country}. Add it to venues.js.`);
            return [place.latitude, place.longitude, 'outdoor'];
          }
        } catch {}
      }
      console.warn(`[weather] No location found for "${team}" (${sport}). Add it to venues.js.`);
      return null;
    })());
  }
  return geocoded.get(key);
}

// ESPN uses US Eastern dates.
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replace(/-/g, '');

function espnDay(sport, ymd) {
  const [path, groups] = ESPN_LEAGUES[sport];
  return cached(`espn:${sport}:${ymd}`, 3 * 60 * 60 * 1000, async () => {
    const games = [];
    for (const g of groups) {
      const res = await fetch(`${ESPN_BASE}/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}&limit=400${g}`);
      if (!res.ok) throw new Error(`ESPN ${res.status}`);
      for (const ev of (await res.json()).events || []) {
        const c = ev.competitions?.[0];
        if (!c) continue;
        games.push({
          teams: (c.competitors || []).map((t) => teamKey(t.team?.displayName || t.team?.name || '')),
          neutral: Boolean(c.neutralSite),
          indoor: Boolean(c.venue?.indoor),
          venue: c.venue?.fullName || '',
          city: c.venue?.address?.city || '',
          state: c.venue?.address?.state || '',
          country: c.venue?.address?.country || '',
        });
      }
    }
    return games;
  });
}

const sameTeam = (a, b) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');

// Returns { name, lat, lon, roof } if ESPN says this game is at a neutral site, else null.
async function neutralSite(sport, ev) {
  if (!ESPN_LEAGUES[sport]) return null;
  try {
    const games = await espnDay(sport, etDate(new Date(ev.commence_time).getTime()));
    const home = teamKey(ev.home_team), away = teamKey(ev.away_team);
    const g = games.find((x) => x.teams.some((t) => sameTeam(t, home)) && x.teams.some((t) => sameTeam(t, away)));
    if (!g || !g.neutral) return null;
    const label = [g.venue, g.city].filter(Boolean).join(', ');
    if (g.indoor) return { name: label, roof: 'dome' };
    const spot = await geocodePlace(g.city, g.state, g.country);
    return spot ? { name: label, lat: spot[0], lon: spot[1], roof: 'outdoor' } : null;
  } catch {
    return null;
  }
}

// City + state/country -> [lat, lon], cached for the life of the server.
const places = new Map();
function geocodePlace(city, state, country) {
  const key = `${city}|${state}|${country}`;
  if (!places.has(key)) {
    places.set(key, (async () => {
      if (!city) return null;
      const url = new URL(GEOCODE_BASE + '/v1/search');
      url.searchParams.set('name', city); url.searchParams.set('count', '20'); url.searchParams.set('language', 'en');
      const res = await fetch(url);
      if (!res.ok) return null;
      const want = STATES[state] || state;
      const results = ((await res.json()).results || []).filter((r) => String(r.feature_code || '').startsWith('PPL'));
      const match = results.find((r) => want && (r.admin1 === want || r.country === want || r.country === country || r.admin1 === country))
        || results.find((r) => country && (r.country === country || (country === 'USA' && r.country_code === 'US')))
        || results.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
      return match ? [match.latitude, match.longitude] : null;
    })().catch(() => null));
  }
  return places.get(key);
}

// What to show for a game: indoors, a forecast for kickoff (or now, if live), or null if no location can be found.
async function weatherFor(sport, ev) {
  if (INDOOR_SPORTS.has(sport)) return { type: 'indoor' };
  let venue = null, approx = false, site = null;
  const neutral = await neutralSite(sport, ev);
  if (neutral) { site = neutral.name; venue = [neutral.lat, neutral.lon, neutral.roof]; }
  if (!venue) venue = venueFor(sport, ev.home_team);
  if (!venue) { venue = await geocodeTeam(sport, ev.home_team); approx = true; }
  if (!venue) return null;
  const [lat, lon, roof] = venue;
  if (roof === 'dome') return { type: 'indoor', site };
  try {
    const h = await forecast(lat, lon);
    const at = Math.max(Date.now(), new Date(ev.commence_time).getTime()) / 1000;
    let best = -1;
    h.time.forEach((t, i) => { if (best < 0 || Math.abs(t - at) < Math.abs(h.time[best] - at)) best = i; });
    if (best < 0 || Math.abs(h.time[best] - at) > 2 * 3600) return { type: roof, later: true, approx, site }; // beyond the forecast window
    return {
      type: roof, approx, site,
      tempF: Math.round(h.temperature_2m[best]),
      windMph: Math.round(h.wind_speed_10m[best]),
      rainPct: h.precipitation_probability[best],
      code: h.weather_code[best],
    };
  } catch {
    return null;
  }
}

// Team EPA/play for football boards, refreshed every 6 hours (nflverse updates daily; CFBD a few times a week).
const EPA_TTL = 6 * 60 * 60 * 1000;
const EPA_LOADERS = { americanfootball_nfl: loadNflEpa, americanfootball_ncaaf: loadCfbEpa };
async function epaFinder(sport) {
  if (!EPA_LOADERS[sport]) return null;
  try {
    const stats = await cached(`epa:${sport}`, EPA_TTL, () => EPA_LOADERS[sport]());
    if (!stats) return null;
    const find = indexTeams(stats);
    const pick = (name) => {
      const t = find(name);
      return t && { net: t.net, off: t.off, def: t.def, netRank: t.netRank, offRank: t.offRank, defRank: t.defRank };
    };
    return (ev) => ({ home: pick(ev.home_team), away: pick(ev.away_team), of: stats.count, through: stats.through, season: stats.season });
  } catch (e) {
    console.warn(`[epa] ${sport}: ${e.message}`);
    return null;
  }
}

function sendJSON(res, status, body, maxAge = 0) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, live: Boolean(API_KEY) });
  if (!API_KEY) return sendJSON(res, 200, { error: 'no_key' });

  if (url.pathname === '/api/sports') {
    // /v4/sports does not count against the usage quota.
    const body = await cached('sports', SPORTS_TTL, async () => {
      const { data } = await upstream('/v4/sports', {});
      return { sports: data.filter((s) => MAJOR_SPORTS.has(s.key)).map((s) => ({ key: s.key, title: s.title, active: s.active })) };
    });
    return sendJSON(res, 200, body, 300);
  }

  if (url.pathname === '/api/odds') {
    const sport = url.searchParams.get('sport');
    const market = url.searchParams.get('market') || 'h2h';
    if (!MAJOR_SPORTS.has(sport)) return sendJSON(res, 400, { error: 'unknown_sport' });
    if (!MARKETS.has(market)) return sendJSON(res, 400, { error: 'unknown_market' });

    const body = await cached(`odds:${sport}:${market}`, (b) => (b.live ? LIVE_TTL : Math.max(LIVE_TTL, Math.min(ODDS_TTL, (b.nextStart ?? Infinity) - Date.now()))), async () => {
      const { data, quota } = await upstream(`/v4/sports/${sport}/odds`, {
        regions: REGIONS, markets: market, oddsFormat: 'decimal', dateFormat: 'iso',
      });
      const now = Date.now();
      const live = data.some((ev) => new Date(ev.commence_time).getTime() <= now);
      // If a game starts before the slow refresh would come round, refresh at kickoff instead.
      const nextStart = Math.min(...data.map((ev) => new Date(ev.commence_time).getTime()).filter((t) => t > now));
      return { fetchedAt: new Date(now).toISOString(), quota, live, nextStart: Number.isFinite(nextStart) ? nextStart : null, events: data };
    });
    const epa = await epaFinder(sport);
    const events = await Promise.all(body.events.map(async (ev) => ({ ...ev, weather: await weatherFor(sport, ev), epa: epa ? epa(ev) : null })));
    const { quota, ...pub } = body; // credit balance stays private (it's in the server log)
    return sendJSON(res, 200, { ...pub, events }, Math.floor((body.live ? LIVE_TTL : ODDS_TTL) / 2000));
  }

  if (url.pathname === '/api/props') {
    const sport = url.searchParams.get('sport');
    const event = url.searchParams.get('event') || '';
    const market = url.searchParams.get('market');
    if (!PROP_MARKETS[sport]?.includes(market)) return sendJSON(res, 400, { error: 'unknown_market' });
    if (!/^[a-zA-Z0-9]{8,64}$/.test(event)) return sendJSON(res, 400, { error: 'bad_event' });

    const body = await cached(`props:${event}:${market}`,
      (b) => (b.live ? PROPS_LIVE_TTL : Math.max(PROPS_LIVE_TTL, Math.min(PROPS_TTL, b.start - Date.now()))),
      async () => {
        const now = Date.now();
        try {
          const { data, quota } = await upstream(`/v4/sports/${sport}/events/${event}/odds`, {
            regions: REGIONS, markets: market, oddsFormat: 'decimal', dateFormat: 'iso',
          });
          const start = new Date(data.commence_time).getTime();
          return { fetchedAt: new Date(now).toISOString(), quota, live: start <= now, start, event: data };
        } catch (e) {
          // Game finished/removed, or no book offers this market: cache the empty answer too.
          if (e.status === 404 || e.status === 422) return { fetchedAt: new Date(now).toISOString(), live: false, start: Infinity, event: null, empty: true };
          throw e;
        }
      });
    const { quota, ...pub } = body;
    return sendJSON(res, 200, pub, Math.floor((body.live ? PROPS_LIVE_TTL : PROPS_TTL) / 2000));
  }

  return sendJSON(res, 404, { error: 'not_found' });
}

// Props create one cache entry per game+market; drop ones nobody has asked for in a while.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of cache) if (/^(props|wx|espn):/.test(k) && v.at < cutoff && !v.inflight) cache.delete(k);
}, 15 * 60 * 1000).unref();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function handleStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html';
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  try {
    const file = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await handleStatic(res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (e) {
    console.error(e.message);
    sendJSON(res, 502, { error: 'upstream_failed', detail: e.message });
  }
}).listen(PORT, () => {
  console.log(`Edge running on http://localhost:${PORT} (${API_KEY ? 'live odds' : 'demo mode — set ODDS_API_KEY'})`);
});
