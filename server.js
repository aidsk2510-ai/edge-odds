// Edge — live odds comparison server
// Zero dependencies. Requires Node 18+ (global fetch).
//
// Proxies The Odds API (https://the-odds-api.com), keeps the API key on the
// server, and caches responses so every visitor shares the same upstream call.

import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDOOR_SPORTS, venueFor, placeGuesses, normalize as teamKey } from './venues.js';
// Optional features load separately, so a missing file switches that feature off instead of crashing the site.
let loadNflEpa = null, loadCfbEpa = null, loadNbaRatings = null, indexTeams = null, loadNflInjuries = null, loadEspnInjuries = null;
try { ({ loadNflEpa, loadCfbEpa, loadNbaRatings, indexTeams, loadNflInjuries, loadEspnInjuries } = await import('./stats.js')); }
catch (e) { console.error(`[startup] Team EPA is off: couldn't load stats.js (${e.message}). Upload stats.js to the main folder.`); }
try { await import('./public/picks-engine.js'); } // defines globalThis.EdgePicks (also used by the page)
catch (e) { console.error(`[startup] Edge Picks is off: couldn't load public/picks-engine.js (${e.message}). Upload it into the public folder.`); }

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
// Stale-while-revalidate: once something has loaded, visitors never wait on a refresh. They get the
// last copy instantly while a single background refresh runs (same number of upstream calls).
// `ttl` is a number of ms, or a function (body) => ms so each response can pick its own lifetime.
function cached(key, ttl, loader) {
  const hit = cache.get(key);
  const has = hit && 'body' in hit;
  if (has && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.body);
  if (hit?.inflight) return has ? Promise.resolve(hit.body) : hit.inflight;
  const inflight = loader()
    .then((body) => {
      cache.set(key, { at: Date.now(), body, ttl: typeof ttl === 'function' ? ttl(body) : ttl });
      return body;
    })
    .catch((e) => {
      console.warn(`[cache] refresh failed for ${key}: ${e.message}`);
      const cur = cache.get(key);
      if (cur && 'body' in cur) { // keep serving the old copy; retry in a minute
        cache.set(key, { at: Date.now(), body: cur.body, ttl: Math.min(cur.ttl, 60 * 1000) });
        return cur.body;
      }
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...hit, inflight });
  if (has) { inflight.catch(() => {}); return Promise.resolve(hit.body); }
  return inflight;
}

// Wait at most `ms` for an optional extra (weather, EPA); if it isn't ready, carry on without it.
// The work keeps going in the background and is cached for the next refresh.
const soon = (promise, ms = 400) => Promise.race([promise.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

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

// ---------- Injuries ----------
// NFL from the official report (nflverse); NBA/NHL/MLB/WNBA from ESPN's public injury list.
const INJURY_LOADERS = loadNflInjuries ? {
  americanfootball_nfl: { load: () => loadNflInjuries(), ttl: 2 * 3600e3 },
  basketball_nba: { load: () => loadEspnInjuries('basketball/nba'), ttl: 30 * 60e3 },
  basketball_wnba: { load: () => loadEspnInjuries('basketball/wnba'), ttl: 30 * 60e3 },
  icehockey_nhl: { load: () => loadEspnInjuries('hockey/nhl'), ttl: 30 * 60e3 },
  baseball_mlb: { load: () => loadEspnInjuries('baseball/mlb'), ttl: 60 * 60e3 },
} : {};
const STATUS_ORDER = (s) => (/^out|^ir|^injured reserve|^suspension/i.test(s) ? 0 : /^doubtful/i.test(s) ? 1 : /^questionable|^day-to-day/i.test(s) ? 2 : /^missed/i.test(s) ? 3 : 4);

async function injuryFinder(sport) {
  const src = INJURY_LOADERS[sport];
  if (!src) return null;
  const data = await cached(`inj:${sport}`, (b) => (b ? src.ttl : 10 * 60e3),
    () => src.load().catch((e) => { console.warn(`[injuries] ${sport}: ${e.message}`); return null; }));
  if (!data) return null;
  const find = indexTeams({ teams: data.teams });
  const filed = data.reported ? indexTeams({ teams: data.reported.map((name) => ({ name })) }) : null;
  const list = (name) => (find(name)?.players || []).slice().sort((a, b) => STATUS_ORDER(a.status) - STATUS_ORDER(b.status));
  const pending = (name) => Boolean(filed && !filed(name)); // NFL team hasn't filed this week's report yet
  return (ev) => ({ source: data.source, updated: data.updated, home: list(ev.home_team), away: list(ev.away_team), homePending: pending(ev.home_team), awayPending: pending(ev.away_team) });
}

// Short text for Ask Edge, e.g. "Lakers: LeBron James (F) Out - foot; ..."
function injuryNote(inj, ev) {
  if (!inj) return null;
  const side = (team, ps, wait) => (wait ? `${team}: this week's report not filed yet` : ps.length ? `${team}: ${ps.slice(0, 8).map((p) => `${p.player}${p.pos ? ` (${p.pos})` : ''} ${p.status}${p.injury ? ` - ${p.injury}` : ''}${p.returns ? `, expected back ${p.returns}` : ''}`).join('; ')}` : `${team}: none listed`);
  return `Injuries (${inj.source}): ${side(ev.away_team, inj.away, inj.awayPending)} | ${side(ev.home_team, inj.home, inj.homePending)}`;
}

// Team EPA/play for football boards, refreshed every 6 hours (nflverse updates daily; CFBD a few times a week).
const EPA_TTL = 6 * 60 * 60 * 1000;
const EPA_LOADERS = loadNflEpa ? { americanfootball_nfl: loadNflEpa, americanfootball_ncaaf: loadCfbEpa, basketball_nba: loadNbaRatings } : {};
async function epaFinder(sport) {
  if (!EPA_LOADERS[sport]) return null;
  try {
    // If a stats source is down, remember that for 10 minutes instead of retrying on every page load.
    const stats = await cached(`epa:${sport}`, (b) => (b ? EPA_TTL : 10 * 60 * 1000),
      () => EPA_LOADERS[sport]().catch((e) => { console.warn(`[epa] ${sport}: ${e.message}`); return null; }));
    if (!stats) return null;
    const find = indexTeams(stats);
    const pick = (name) => {
      const t = find(name);
      return t && { net: t.net, off: t.off, def: t.def, netRank: t.netRank, offRank: t.offRank, defRank: t.defRank };
    };
    return (ev) => ({ kind: stats.kind || 'epa', home: pick(ev.home_team), away: pick(ev.away_team), of: stats.count, through: stats.through, season: stats.season });
  } catch (e) {
    console.warn(`[epa] ${sport}: ${e.message}`);
    return null;
  }
}

// Compress anything over 1 KB when the browser accepts gzip (odds boards shrink ~10x).
function send(res, status, headers, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJSON(res, status, body, maxAge = 0) {
  send(res, status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  }, JSON.stringify(body));
}

// Player props for one game and one stat, cached (shared by the props drawer and Ask Edge).
function getProps(sport, event, market) {
  return cached(`props:${event}:${market}`,
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
}

// One sport + bet type from The Odds API, cached (shared by the odds board and Edge Picks).
function getOdds(sport, market) {
  return cached(`odds:${sport}:${market}`, (b) => (b.live ? LIVE_TTL : Math.max(LIVE_TTL, Math.min(ODDS_TTL, (b.nextStart ?? Infinity) - Date.now()))), async () => {
    const { data, quota } = await upstream(`/v4/sports/${sport}/odds`, {
      regions: REGIONS, markets: market, oddsFormat: 'decimal', dateFormat: 'iso',
    });
    const now = Date.now();
    const live = data.some((ev) => new Date(ev.commence_time).getTime() <= now);
    // If a game starts before the slow refresh would come round, refresh at kickoff instead.
    const nextStart = Math.min(...data.map((ev) => new Date(ev.commence_time).getTime()).filter((t) => t > now));
    return { fetchedAt: new Date(now).toISOString(), quota, live, nextStart: Number.isFinite(nextStart) ? nextStart : null, events: data };
  });
}

// ---------- Edge Picks: math engine + optional AI write-up ----------
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const AI_BASE = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '');
const AI_TTL = (Number(process.env.PICKS_AI_MINUTES) || 15) * 60 * 1000; // one write-up per sport per 15 min
const PICK_MARKETS = ['h2h', 'spreads', 'totals'];
const SPORT_NAMES = {
  americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'college football', basketball_nba: 'NBA', basketball_ncaab: 'college basketball',
  basketball_wnba: 'WNBA', baseball_mlb: 'MLB', icehockey_nhl: 'NHL', soccer_epl: 'Premier League', soccer_uefa_champs_league: 'Champions League',
  soccer_usa_mls: 'MLS', soccer_spain_la_liga: 'La Liga', mma_mixed_martial_arts: 'UFC/MMA',
};
const AI_SYSTEM = `You write the "Edge Picks" note on a sports odds comparison website. You receive numbers the site's math engine already calculated:
- fairChance: each bet's real chance of winning, averaged from all sportsbooks after removing their built-in margin.
- best price at a licensed US sportsbook for that bet.
- edge: positive means the price pays more than the fair chance says (a bargain); negative means the sportsbook keeps about that much on average.
Parlays are priced at a single sportsbook, one leg per game.

Write for a casual bettor in plain, simple words that a 5th grader could follow. 120 to 180 words, plain text, in this shape:
One sentence on today's board: are there real bargains or not.
Best single: one bet, with the sportsbook, the price, and its chance to win.
Best parlay: the legs, the sportsbook, the price, what a $10 bet returns, and how often it hits (say it like "about 1 in 5").
Skip: one thing to avoid and why.
A last line reminding people to check prices at the sportsbook before betting.

Rules: use only the numbers given and copy prices exactly. Never invent injuries, news, stats, records, or trends. Never promise a win or call anything a lock. If every edge is negative, say plainly that nothing is a true bargain and these are the cheapest options. No markdown symbols.`;

async function writePicksNote(sport, r) {
  const et = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const data = {
    sport: SPORT_NAMES[sport] || sport,
    singles: r.singles.slice(0, 6).map((x) => ({ pick: x.pick, game: x.game, starts: `${et(x.start)} ET`, sportsbook: x.best.title, price: x.bestOdds, fairChance: pct(x.fair), edge: `${(x.edge * 100).toFixed(1)}%` })),
    parlays: r.parlays.slice(0, 3).map((p) => ({ legs: p.legs.map((l) => `${l.pick} (${l.game})`), sportsbook: p.title, price: p.odds, tenDollarsReturns: `$${(10 * p.dec).toFixed(2)}`, hitChance: pct(p.hit), edge: `${(p.ev * 100).toFixed(1)}%` })),
  };
  const res = await fetch(`${AI_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 2000, system: AI_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(data) }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Claude API returned no text');
  if (out.usage) console.log(`[picks] AI note for ${sport}: ${out.usage.input_tokens} in / ${out.usage.output_tokens} out tokens`);
  return { text, at: new Date().toISOString(), model: AI_MODEL };
}

// ---------- Ask Edge: universal Q&A across every sport ----------
// Claude doesn't get the whole site up front (that would cost too many odds credits). Instead it calls tools
// that look things up on demand: best bets, games (with weather + EPA), player props, and parlay pricing.
const ASK_MODEL = process.env.ANTHROPIC_CHAT_MODEL || AI_MODEL;
const ASK_LIMIT_PER_MIN = Number(process.env.ASK_PER_MINUTE) || 6;
const ASK_LIMIT_PER_DAY = Number(process.env.ASK_PER_DAY) || 60;
const ASK_HORIZON_DAYS = Number(process.env.ASK_HORIZON_DAYS) || 7;
const ASK_SCAN_MAX_AGE = (Number(process.env.ASK_SCAN_MINUTES) || 30) * 60e3; // reuse odds this old before paying for fresh ones
const askHits = new Map(); // visitor ip -> timestamps of recent questions

function askAllowed(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const recent = (askHits.get(ip) || []).filter((t) => now - t < 24 * 3600e3);
  if (recent.filter((t) => now - t < 60e3).length >= ASK_LIMIT_PER_MIN) return { ok: false, why: 'minute' };
  if (recent.length >= ASK_LIMIT_PER_DAY) return { ok: false, why: 'day' };
  recent.push(now); askHits.set(ip, recent);
  return { ok: true };
}
setInterval(() => { const cut = Date.now() - 24 * 3600e3; for (const [ip, ts] of askHits) { const keep = ts.filter((t) => t > cut); keep.length ? askHits.set(ip, keep) : askHits.delete(ip); } }, 30 * 60e3).unref();

async function readJson(req, limit = 20000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('too_large'), { status: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const etTime = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;

// Odds for Ask Edge: reuse anything cached in the last ASK_SCAN_MINUTES instead of paying for a refresh.
function askOdds(sport, market) {
  const hit = cache.get(`odds:${sport}:${market}`);
  if (hit && 'body' in hit && Date.now() - hit.at < ASK_SCAN_MAX_AGE) return Promise.resolve(hit.body);
  return getOdds(sport, market);
}

// Sports that currently have games (the /v4/sports list is free), falling back to all.
async function activeSports() {
  try {
    const body = await cached('sports', SPORTS_TTL, async () => {
      const { data } = await upstream('/v4/sports', {});
      return { sports: data.filter((x) => MAJOR_SPORTS.has(x.key)).map((x) => ({ key: x.key, title: x.title, active: x.active })) };
    });
    const act = body.sports.filter((x) => x.active).map((x) => x.key);
    return act.length ? act : [...MAJOR_SPORTS];
  } catch { return [...MAJOR_SPORTS]; }
}

const SPORT_ALIASES = {
  nfl: 'americanfootball_nfl', football: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', 'college football': 'americanfootball_ncaaf', cfb: 'americanfootball_ncaaf',
  nba: 'basketball_nba', ncaab: 'basketball_ncaab', 'college basketball': 'basketball_ncaab', cbb: 'basketball_ncaab', wnba: 'basketball_wnba',
  nhl: 'icehockey_nhl', hockey: 'icehockey_nhl', mlb: 'baseball_mlb', baseball: 'baseball_mlb',
  epl: 'soccer_epl', 'premier league': 'soccer_epl', ucl: 'soccer_uefa_champs_league', 'champions league': 'soccer_uefa_champs_league',
  mls: 'soccer_usa_mls', 'la liga': 'soccer_spain_la_liga', laliga: 'soccer_spain_la_liga', ufc: 'mma_mixed_martial_arts', mma: 'mma_mixed_martial_arts',
};
const toSport = (x) => { const k = String(x || '').toLowerCase().trim(); return MAJOR_SPORTS.has(k) ? k : SPORT_ALIASES[k] || null; };

// One sport's bets (main line per game and bet type) with weather + EPA notes, cached 60s.
function sportBoard(sport) {
  return cached(`askboard:${sport}`, 60e3, async () => {
    const markets = sport === 'mma_mixed_martial_arts' ? ['h2h', 'totals'] : PICK_MARKETS;
    const boards = await Promise.all(markets.map((m) => askOdds(sport, m).catch(() => null)));
    const events = mergeBoards(boards);
    const fetchedAt = boards.filter(Boolean).map((b) => b.fetchedAt).sort()[0] || null;
    const r = globalThis.EdgePicks.analyze(events, { markets, horizonHours: ASK_HORIZON_DAYS * 24, maxSingles: 0, maxParlays: 0 });
    const main = new Map();
    for (const x of r.sides) { const k = `${x.eventId}|${x.market}`; if (!main.has(k) || x.books > main.get(k).books) main.set(k, { line: x.line, books: x.books }); }
    const sides = r.sides.filter((x) => main.get(`${x.eventId}|${x.market}`).line === x.line);
    const epa = await soon(epaFinder(sport), 800);
    const inj = await soon(injuryFinder(sport), 1500);
    const games = new Map();
    for (const ev of events) {
      if (!sides.some((x) => x.eventId === ev.id)) continue;
      const w = await soon(weatherFor(sport, ev), 300);
      const e = epa ? epa(ev) : null;
      games.set(ev.id, {
        sport, eventId: ev.id, home: ev.home_team, away: ev.away_team, start: ev.commence_time, game: `${ev.away_team} @ ${ev.home_team}`,
        weather: !w ? null : w.type === 'indoor' ? `Indoors${w.site ? ` (${w.site})` : ''}` : w.tempF != null ? `${w.tempF}F, ${w.windMph} mph wind, ${w.rainPct || 0}% chance of precipitation${w.type === 'retractable' ? ', retractable roof' : ''}${w.site ? `, at ${w.site}` : ''}` : 'Forecast not out yet',
        injuries: inj ? injuryNote(inj(ev), ev) : null,
        epa: e && e.home && e.away ? (e.kind === 'rating'
          ? `Team ratings, points per 100 possessions (${e.through || 'season'}; rank of ${e.of}; defense: lower is better): ${[[ev.away_team, e.away], [ev.home_team, e.home]].map(([n, t]) => `${n} offense ${t.off.toFixed(1)} #${t.offRank}, defense ${t.def.toFixed(1)} #${t.defRank}, net ${t.net >= 0 ? '+' : ''}${t.net.toFixed(1)} #${t.netRank}`).join('; ')}`
          : `EPA per play (${e.through || 'season'}; rank of ${e.of}; defense: lower is better): ${[[ev.away_team, e.away], [ev.home_team, e.home]].map(([n, t]) => `${n} offense ${t.off.toFixed(2)} #${t.offRank}, defense ${t.def.toFixed(2)} #${t.defRank}, net ${t.net.toFixed(2)} #${t.netRank}`).join('; ')}`) : null,
      });
    }
    const titles = {};
    for (const ev of events) for (const bk of ev.bookmakers) titles[bk.key] = bk.title;
    return { sport, sides, games, events, fetchedAt, titles };
  });
}

// Per-question registry: short IDs (G1, B1, P1) that Claude passes back to the tools.
function newRegistry() {
  const r = { games: new Map(), bets: new Map(), gameIds: new Map(), betIds: new Map(), titles: {}, n: { G: 0, B: 0, P: 0 } };
  r.game = (g) => { const k = `${g.sport}|${g.eventId}`; if (!r.gameIds.has(k)) { const id = `G${++r.n.G}`; r.gameIds.set(k, id); r.games.set(id, g); } return r.gameIds.get(k); };
  r.bet = (b, prefix = 'B') => { const k = `${b.eventId}|${b.market}|${b.pick}`; if (!r.betIds.has(k)) { const id = `${prefix}${++r.n[prefix]}`; r.betIds.set(k, id); r.bets.set(id, b); } return r.betIds.get(k); };
  return r;
}
const betView = (reg, x, g) => ({
  id: reg.bet(x), game_id: reg.game(g), sport: SPORT_NAMES[g.sport] || g.sport, game: g.game, starts: `${etTime(g.start)} ET`,
  bet: x.pick, type: x.market === 'h2h' ? 'moneyline' : x.market === 'spreads' ? 'spread' : 'total',
  best_price: x.bestOdds, sportsbook: x.best.title, fair_chance: pct1(x.fair), fair_price: x.fairOdds, edge: pct1(x.edge), books: x.books,
});

async function toolFindBestBets(reg, input) {
  const wanted = (Array.isArray(input.sports) && input.sports.length ? input.sports.map(toSport).filter(Boolean) : await activeSports());
  const days = Math.min(ASK_HORIZON_DAYS, Math.max(1, Number(input.days) || 2));
  const market = ['h2h', 'spreads', 'totals'].includes(input.market) ? input.market : null;
  const limit = Math.min(15, Math.max(1, Number(input.limit) || 8));
  const boards = (await Promise.all(wanted.map((sp) => sportBoard(sp).catch(() => null)))).filter(Boolean);
  for (const b of boards) Object.assign(reg.titles, b.titles);
  const until = Date.now() + days * 864e5;
  const pool = [];
  for (const b of boards) for (const x of b.sides) {
    if (market && x.market !== market) continue;
    if (new Date(x.start).getTime() > until) continue;
    pool.push({ x, g: b.games.get(x.eventId), board: b });
  }
  pool.sort((a, b) => b.x.edge - a.x.edge);
  // Parlays across all chosen sports: one leg per game, all at one sportsbook
  const events = boards.flatMap((b) => b.events.filter((ev) => new Date(ev.commence_time).getTime() <= until).map((ev) => ({ ...ev, _sport: b.sport })));
  const pr = globalThis.EdgePicks.analyze(events, { markets: market ? [market] : PICK_MARKETS, horizonHours: days * 24, maxSingles: 0, maxParlays: 4 });
  const findSide = (leg) => pool.find((p) => p.x.pick === leg.pick && p.x.game === leg.game);
  return {
    sports_checked: boards.map((b) => SPORT_NAMES[b.sport] || b.sport),
    prices_as_of: boards.map((b) => b.fetchedAt).filter(Boolean).sort()[0] ? `${etTime(boards.map((b) => b.fetchedAt).filter(Boolean).sort()[0])} ET or later` : null,
    best_bets: pool.slice(0, limit).map(({ x, g }) => ({ ...betView(reg, x, g), weather: g.weather, epa: g.epa, injuries: g.injuries })),
    best_parlays: pr.parlays.map((p) => ({
      legs: p.legs.map((l) => { const f = findSide(l); return f ? `${reg.bet(f.x)}: ${l.pick} ${l.odds} (${l.game})` : `${l.pick} ${l.odds} (${l.game})`; }),
      sportsbook: p.title, odds: p.odds, ten_dollars_returns: `$${(10 * p.dec).toFixed(2)}`, chance_all_win: pct1(p.hit), edge: pct1(p.ev),
    })),
  };
}

async function toolListGames(reg, input) {
  const sport = toSport(input.sport);
  if (!sport) return { error: `Unknown sport "${input.sport}". Options: ${[...MAJOR_SPORTS].map((k) => SPORT_NAMES[k]).join(', ')}.` };
  const days = Math.min(ASK_HORIZON_DAYS, Math.max(1, Number(input.days) || 3));
  const team = String(input.team || '').toLowerCase().trim();
  const b = await sportBoard(sport);
  Object.assign(reg.titles, b.titles);
  const until = Date.now() + days * 864e5;
  const games = [...b.games.values()]
    .filter((g) => new Date(g.start).getTime() <= until && (!team || g.game.toLowerCase().includes(team)))
    .sort((a, c) => new Date(a.start) - new Date(c.start)).slice(0, 25);
  return {
    sport: SPORT_NAMES[sport], prices_as_of: b.fetchedAt ? `${etTime(b.fetchedAt)} ET` : null, games_found: games.length,
    player_props_available: (PROP_MARKETS[sport] || []).length > 0,
    games: games.map((g) => ({
      game_id: reg.game(g), game: g.game, starts: `${etTime(g.start)} ET`, weather: g.weather, epa: g.epa, injuries: g.injuries,
      bets: b.sides.filter((x) => x.eventId === g.eventId).map((x) => { const v = betView(reg, x, g); return { id: v.id, bet: v.bet, type: v.type, best_price: v.best_price, sportsbook: v.sportsbook, fair_chance: v.fair_chance, fair_price: v.fair_price, edge: v.edge }; }),
    })),
  };
}

const PROP_LABELS = {
  player_pass_yds: 'passing yards', player_rush_yds: 'rushing yards', player_reception_yds: 'receiving yards', player_receptions: 'receptions', player_pass_tds: 'passing TDs', player_anytime_td: 'anytime TD',
  player_points: 'points', player_rebounds: 'rebounds', player_assists: 'assists', player_threes: 'threes', player_points_rebounds_assists: 'points + rebounds + assists',
  player_shots_on_goal: 'shots on goal', player_goal_scorer_anytime: 'anytime goal', batter_hits: 'hits', batter_home_runs: 'home runs', batter_total_bases: 'total bases', pitcher_strikeouts: 'strikeouts', player_shots_on_target: 'shots on target',
};

async function toolPlayerProps(reg, input) {
  const g = reg.games.get(String(input.game_id || '').toUpperCase());
  if (!g) return { error: 'Unknown game_id. Call list_games or find_best_bets first and use a game_id from the results.' };
  const markets = PROP_MARKETS[g.sport] || [];
  const stat = String(input.stat || '').trim();
  const market = markets.find((m) => m === stat) || markets.find((m) => (PROP_LABELS[m] || '').toLowerCase() === stat.toLowerCase());
  if (!market) return { error: `Pick a stat for ${SPORT_NAMES[g.sport]}: ${markets.map((m) => `${m} (${PROP_LABELS[m]})`).join(', ') || 'none available'}.` };
  const body = await getProps(g.sport, g.eventId, market);
  const ev = body.event;
  if (!ev || !ev.bookmakers?.length) return { game: g.game, stat: PROP_LABELS[market], players: [], note: 'No sportsbook has posted these props yet. They usually appear closer to game time.' };
  const licensed = new Set(globalThis.EdgePicks.LICENSED);
  // Group each player's line: Over/Under at the same number across books
  const groups = new Map();
  for (const b of ev.bookmakers) {
    reg.titles[b.key] = b.title;
    const m = b.markets.find((x) => x.key === market);
    for (const o of m?.outcomes || []) {
      const player = o.description || o.name;
      const key = `${player}|${o.point ?? ''}`;
      if (!groups.has(key)) groups.set(key, { player, point: o.point ?? null, books: new Map() });
      const gb = groups.get(key).books;
      if (!gb.has(b.key)) gb.set(b.key, {});
      gb.get(b.key)[o.description ? o.name : 'Yes'] = o.price;
    }
  }
  const out = [];
  for (const grp of groups.values()) {
    const two = [...grp.books.entries()].filter(([, v]) => v.Over && v.Under);
    const sidesHere = grp.point != null && two.length ? ['Over', 'Under'] : ['Yes'];
    for (const side of sidesHere) {
      const offers = Object.fromEntries([...grp.books.entries()].filter(([k, v]) => licensed.has(k) && v[side]).map(([k, v]) => [k, v[side]]));
      const bestKey = Object.keys(offers).sort((a, c) => offers[c] - offers[a])[0];
      if (!bestKey) continue;
      let fair = null;
      if (side !== 'Yes' && two.length >= 2) {
        fair = two.reduce((sum, [, v]) => { const a = 1 / v[side], b2 = 1 / v[side === 'Over' ? 'Under' : 'Over']; return sum + a / (a + b2); }, 0) / two.length;
      }
      const pick = side === 'Yes' ? `${grp.player} ${PROP_LABELS[market]}` : `${grp.player} ${side} ${grp.point} ${PROP_LABELS[market]}`;
      const bet = { eventId: g.eventId, market, pick, game: g.game, start: g.start, fair, offers, best: { book: bestKey, title: reg.titles[bestKey] || bestKey, price: offers[bestKey] } };
      out.push({
        id: reg.bet(bet, 'P'), bet: pick, best_price: globalThis.EdgePicks.fmtAmerican(offers[bestKey]), sportsbook: bet.best.title,
        fair_chance: fair != null ? pct1(fair) : 'unknown (only one side offered)', edge: fair != null ? pct1(fair * offers[bestKey] - 1) : 'unknown', books: grp.books.size,
      });
    }
  }
  out.sort((a, c) => c.books - a.books || a.bet.localeCompare(c.bet));
  return { game: g.game, stat: PROP_LABELS[market], prices_as_of: `${etTime(body.fetchedAt)} ET`, players: out.slice(0, 40) };
}

function toolPriceBet(reg, input) {
  const stake = Number(input.stake) > 0 ? Number(input.stake) : 10;
  const legs = (input.legs || []).map((id) => ({ id, bet: reg.bets.get(String(id).toUpperCase()) }));
  const missing = legs.filter((l) => !l.bet).map((l) => l.id);
  if (!legs.length) return { error: 'Give at least one bet id.' };
  if (missing.length) return { error: `Unknown bet ids: ${missing.join(', ')}. Use ids returned by the other tools in this conversation turn.` };
  const sameGame = new Set(legs.map((l) => l.bet.eventId)).size < legs.length;
  const books = Object.keys(legs[0].bet.offers).filter((b) => legs.every((l) => l.bet.offers[b]));
  if (!books.length) return { error: 'No single licensed sportsbook offers every one of these legs, so they cannot be combined into one parlay. Try swapping a leg.' };
  const title = (k) => reg.titles[k] || legs.map((l) => (l.bet.best.book === k ? l.bet.best.title : null)).find(Boolean) || k;
  const options = books.map((k) => { const dec = legs.reduce((p, l) => p * l.bet.offers[k], 1); return { sportsbook: title(k), odds: globalThis.EdgePicks.fmtAmerican(dec), total_return: +(stake * dec).toFixed(2), dec }; }).sort((a, b) => b.dec - a.dec);
  const known = legs.every((l) => l.bet.fair != null);
  const hit = known ? legs.reduce((p, l) => p * l.bet.fair, 1) : null;
  const best = options[0];
  return {
    legs: legs.map((l) => `${l.bet.pick} (${l.bet.game})`), stake,
    best_sportsbook: best.sportsbook, odds: best.odds, total_return: best.total_return, profit_if_it_wins: +(best.total_return - stake).toFixed(2),
    chance_all_win: hit != null ? `${pct1(hit)} (about 1 in ${Math.max(1, Math.round(1 / hit))})` : 'unknown for at least one leg',
    edge: hit != null ? pct1(hit * best.dec - 1) : 'unknown',
    other_sportsbooks: options.slice(1, 4).map(({ dec, ...o }) => o),
    ...(sameGame ? { warning: 'Some legs are from the same game. Sportsbooks price those as a same-game parlay, usually lower than shown here, so treat these numbers as a rough guide.' } : {}),
  };
}

const ASK_TOOLS = [
  { name: 'find_best_bets', description: 'Scan one, several, or all sports for the best-priced bets (biggest edge) and the best parlays (one leg per game, all at one sportsbook). Results include weather, team stats (football EPA, NBA ratings) and injury reports for each game. Use this for "best bets", "what should I bet", "build me a parlay" across sports.',
    input_schema: { type: 'object', properties: {
      sports: { type: 'array', items: { type: 'string' }, description: 'Sports to include, e.g. ["NFL","NBA"]. Leave empty for every sport in season.' },
      days: { type: 'number', description: 'How many days ahead to look (1-7). Default 2.' },
      market: { type: 'string', enum: ['h2h', 'spreads', 'totals'], description: 'Only one bet type (h2h = moneyline). Leave out for all.' },
      limit: { type: 'number', description: 'How many single bets to return (max 15). Default 8.' } } } },
  { name: 'list_games', description: 'List upcoming games for one sport with every main-line bet (moneyline, spread, total) and its best price, fair chance and edge, plus weather, team stats (football EPA, NBA offensive/defensive/net rating) and injury reports. Use to look up a specific team or game, or who is injured.',
    input_schema: { type: 'object', properties: {
      sport: { type: 'string', description: 'e.g. "NFL", "college football", "NBA", "NHL", "Premier League", "UFC".' },
      days: { type: 'number', description: 'Days ahead (1-7). Default 3.' },
      team: { type: 'string', description: 'Optional team name to filter, e.g. "Chiefs".' } }, required: ['sport'] } },
  { name: 'get_player_props', description: 'Get player prop lines for one game and one stat (e.g. points, passing yards), with the best price, sportsbook, fair chance and edge for each player. Needs a game_id from list_games or find_best_bets.',
    input_schema: { type: 'object', properties: {
      game_id: { type: 'string', description: 'e.g. "G3"' },
      stat: { type: 'string', description: 'Stat key or name, e.g. "player_points" or "points", "passing yards", "anytime TD".' } }, required: ['game_id', 'stat'] } },
  { name: 'price_bet', description: 'Price one bet or a parlay from bet ids returned by the other tools (B… for game bets, P… for player props), across any sports. Returns the licensed sportsbook that pays most for ALL legs together, the odds, what the stake returns, the chance all legs win and the edge. Always use this for payout or parlay math.',
    input_schema: { type: 'object', properties: {
      legs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Bet ids, e.g. ["B2","B7","P4"]' },
      stake: { type: 'number', description: 'Dollars bet. Default 10.' } }, required: ['legs'] } },
];

async function runTool(reg, name, input) {
  try {
    if (name === 'find_best_bets') return await toolFindBestBets(reg, input);
    if (name === 'list_games') return await toolListGames(reg, input);
    if (name === 'get_player_props') return await toolPlayerProps(reg, input);
    if (name === 'price_bet') return toolPriceBet(reg, input);
    return { error: 'Unknown tool' };
  } catch (e) {
    console.warn(`[ask] tool ${name} failed: ${e.message}`);
    return { error: 'That lookup failed. Try again or ask a different way.' };
  }
}

async function askSystem(viewing) {
  const today = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const active = (await activeSports()).map((k) => SPORT_NAMES[k] || k).join(', ');
  return `You are Edge, the betting assistant on the Edge odds comparison website. It is ${today} ET.
Sports in season on the site: ${active}.${viewing ? ` The user is currently looking at ${SPORT_NAMES[viewing] || viewing}, which is a hint, not a limit.` : ''}

You can see everything on the site through tools: odds for every sport (moneyline, spread, total), each bet's best price at licensed US sportsbooks, fair chance, fair price and edge, plus weather, team stats (EPA per play for NFL and college football; offensive, defensive and net rating for the NBA), injury reports (NFL official report; NBA, NHL, MLB and WNBA from ESPN's injury list), and player props. Look things up with the tools. Never guess a price, team, line or number.
- "fair chance" = all sportsbooks' prices combined with each book's built-in cut removed. It is the market's estimate, not a separate prediction.
- "edge" = how the best price compares with the fair chance. Positive is a bargain; negative is what the sportsbook keeps on average.
- A parlay must be placed at one sportsbook. Legs can come from different sports. Use price_bet for every parlay or payout calculation; never do that math yourself.
- Weather and EPA are useful context: strong wind, rain or snow can lower scoring and passing; a much higher net EPA or net rating usually means the stronger team (small early-season samples are noisy). Mention them when relevant, but do not invent precise effects. The price-based edge is the main measure of value.

How to answer:
- Be short and plain, so a 5th grader could follow: usually 2 to 6 sentences or a short dash list. Plain text, no markdown headers, tables or bold. Never show internal ids (like B3, G2, P5).
- Copy prices, lines and sportsbook names exactly from tool results. Give the chance of winning when you recommend something.
- "Best bet" means best price compared with the fair chance, not a sure winner. Never promise a win or call anything a lock or guaranteed.
- Injuries: use the injury reports in tool results and name the source (and NFL report week). They can lag late news, so for game-time decisions suggest checking right before the game. College football, college basketball, soccer and UFC have no injury data here. Beyond what the tools return, you do not know lineups, news, player stats, records or trends.
- When a key player is Out or Doubtful, mention it next to that pick. The odds usually already reflect known injuries, so do not treat an injury as a reason the price is wrong.
- Live games are not included. Games far ahead may not have prices yet.
- If someone mentions chasing losses, betting money they need, or feeling out of control, be kind, suggest a break, and share the 1-800-GAMBLER helpline.
- Stay on sports betting and this site. Politely decline unrelated requests.`;
}

async function claude(body) {
  const res = await fetch(`${AI_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function answerQuestion(viewing, history, question) {
  const reg = newRegistry();
  const system = await askSystem(viewing);
  const messages = [...history, { role: 'user', content: question }];
  let usageIn = 0, usageOut = 0, tools = 0;
  for (let step = 0; step < 7; step++) {
    const out = await claude({ model: ASK_MODEL, max_tokens: 1500, system, tools: ASK_TOOLS, messages });
    usageIn += out.usage?.input_tokens || 0; usageOut += out.usage?.output_tokens || 0;
    if (out.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: out.content });
      const results = [];
      for (const b of out.content.filter((x) => x.type === 'tool_use')) {
        tools++;
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(reg, b.name, b.input || {})) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    console.log(`[ask] ${usageIn} in / ${usageOut} out tokens, ${tools} tool call${tools === 1 ? '' : 's'}`);
    return { text: text || 'Sorry, I could not come up with an answer. Try asking another way.' };
  }
  return { text: 'That took too many steps. Try a simpler question.' };
}

// Merge the moneyline, spread and total boards into one list of games.
function mergeBoards(boards) {
  const byId = new Map();
  for (const board of boards) {
    for (const ev of board?.events || []) {
      if (!byId.has(ev.id)) byId.set(ev.id, { ...ev, bookmakers: [] });
      const target = byId.get(ev.id);
      for (const b of ev.bookmakers || []) {
        let tb = target.bookmakers.find((x) => x.key === b.key);
        if (!tb) { tb = { key: b.key, title: b.title, markets: [] }; target.bookmakers.push(tb); }
        tb.markets.push(...(b.markets || []));
      }
    }
  }
  return [...byId.values()];
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

    const body = await getOdds(sport, market);
    const [epa, inj, weather] = await Promise.all([
      soon(epaFinder(sport)),
      soon(injuryFinder(sport)),
      Promise.all(body.events.map((ev) => soon(weatherFor(sport, ev)))),
    ]);
    const events = body.events.map((ev, i) => ({ ...ev, weather: weather[i], epa: epa ? epa(ev) : null, injuries: inj ? inj(ev) : null }));
    const { quota, ...pub } = body; // credit balance stays private (it's in the server log)
    // Tell the page when this is an older copy and a fresh one is on its way, so it can check back in a few seconds.
    const entry = cache.get(`odds:${sport}:${market}`);
    const refreshing = Boolean(entry?.inflight) || (entry && Date.now() - entry.at >= entry.ttl);
    return sendJSON(res, 200, { ...pub, events, refreshing }); // no browser caching: the server cache handles load
  }

  if (url.pathname === '/api/ask') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'post_only' });
    if (!AI_KEY || !globalThis.EdgePicks) return sendJSON(res, 503, { error: 'ai_off' });
    const allowed = askAllowed(req);
    if (!allowed.ok) return sendJSON(res, 429, { error: allowed.why === 'day' ? 'daily_limit' : 'slow_down' });
    let body;
    try { body = await readJson(req); } catch (e) { return sendJSON(res, e.status || 400, { error: 'bad_request' }); }
    const viewing = MAJOR_SPORTS.has(body.viewing) ? body.viewing : MAJOR_SPORTS.has(body.sport) ? body.sport : null;
    const question = String(body.question || '').trim().slice(0, 600);
    if (!question) return sendJSON(res, 400, { error: 'bad_request' });
    // Keep the last few turns; they must alternate user/assistant and start with the user.
    const history = [];
    for (const h of (Array.isArray(body.history) ? body.history : []).slice(-8)) {
      const role = h?.role === 'assistant' ? 'assistant' : h?.role === 'user' ? 'user' : null;
      const text = String(h?.text || '').slice(0, 2000);
      if (!role || !text) continue;
      if (history.length ? history[history.length - 1].role === role : role !== 'user') continue;
      history.push({ role, content: text });
    }
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    try {
      return sendJSON(res, 200, await answerQuestion(viewing, history, question));
    } catch (e) {
      console.warn(`[ask] failed: ${e.message}`);
      return sendJSON(res, 502, { error: 'ai_failed' });
    }
  }

  if (url.pathname === '/api/picks') {
    const sport = url.searchParams.get('sport');
    if (!MAJOR_SPORTS.has(sport)) return sendJSON(res, 400, { error: 'unknown_sport' });
    if (!globalThis.EdgePicks) return sendJSON(res, 503, { error: 'picks_unavailable' });
    const boards = await Promise.all(PICK_MARKETS.map((m) => getOdds(sport, m).catch(() => null)));
    const r = globalThis.EdgePicks.analyze(mergeBoards(boards), { markets: PICK_MARKETS });
    const strip = (x) => { const { offers, ...rest } = x; return rest; };
    let note = null, pending = false;
    if (AI_KEY && r.singles.length) {
      const job = cached(`ai:${sport}`, AI_TTL, () => writePicksNote(sport, r));
      note = await soon(job, 150);
      pending = !note;
    }
    return sendJSON(res, 200, {
      sport, generatedAt: r.generatedAt, games: r.games, singles: r.singles.map(strip), parlays: r.parlays,
      note, pending, plain: globalThis.EdgePicks.plainSummary(r),
    });
  }

  if (url.pathname === '/api/props') {
    const sport = url.searchParams.get('sport');
    const event = url.searchParams.get('event') || '';
    const market = url.searchParams.get('market');
    if (!PROP_MARKETS[sport]?.includes(market)) return sendJSON(res, 400, { error: 'unknown_market' });
    if (!/^[a-zA-Z0-9]{8,64}$/.test(event)) return sendJSON(res, 400, { error: 'bad_event' });

    const body = await getProps(sport, event, market);
    const { quota, ...pub } = body;
    const entry = cache.get(`props:${event}:${market}`);
    const refreshing = Boolean(entry?.inflight) || (entry && Date.now() - entry.at >= entry.ttl);
    return sendJSON(res, 200, { ...pub, refreshing });
  }

  return sendJSON(res, 404, { error: 'not_found' });
}

// Props create one cache entry per game+market; drop ones nobody has asked for in a while.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of cache) if (/^(props|wx|espn|ai|askboard):/.test(k) && v.at < cutoff && !v.inflight) cache.delete(k);
}, 15 * 60 * 1000).unref();

// Visitor analytics: paste your Cloudflare Web Analytics site token into CF_ANALYTICS_TOKEN and the
// beacon script is added to the page automatically. (The site token is public; API keys are not.)
const CF_TOKEN = (process.env.CF_ANALYTICS_TOKEN || '').trim();
let analyticsTag = '';
if (CF_TOKEN) {
  if (/^cfk_|^cfut_|^cfat_/i.test(CF_TOKEN) || CF_TOKEN.length > 64) {
    console.warn('[analytics] CF_ANALYTICS_TOKEN looks like a secret Cloudflare API key, not a Web Analytics site token. Not adding it to the page. Use the token from the Web Analytics snippet instead.');
  } else if (!/^[A-Za-z0-9_-]{16,64}$/.test(CF_TOKEN)) {
    console.warn('[analytics] CF_ANALYTICS_TOKEN has unexpected characters. Copy just the token from the Web Analytics snippet.');
  } else {
    analyticsTag = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${CF_TOKEN}"}'></script>`;
    console.log('[analytics] Cloudflare Web Analytics is on.');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function handleStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html';
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  try {
    let file = await readFile(join(ROOT, rel));
    if (analyticsTag && rel === 'index.html') file = Buffer.from(file.toString('utf8').replace('</body>', `${analyticsTag}\n</body>`));
    send(res, 200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-cache' }, file);
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
  // Start the slow loads right away so the first visitor after a restart doesn't wait for them.
  if (API_KEY) for (const sport of Object.keys(EPA_LOADERS)) epaFinder(sport);
  if (API_KEY) for (const sport of Object.keys(INJURY_LOADERS)) injuryFinder(sport);
});
