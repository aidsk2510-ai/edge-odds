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
let loadNflEpa = null, loadCfbEpa = null, indexTeams = null;
try { ({ loadNflEpa, loadCfbEpa, indexTeams } = await import('./stats.js')); }
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

// Team EPA/play for football boards, refreshed every 6 hours (nflverse updates daily; CFBD a few times a week).
const EPA_TTL = 6 * 60 * 60 * 1000;
const EPA_LOADERS = loadNflEpa ? { americanfootball_nfl: loadNflEpa, americanfootball_ncaaf: loadCfbEpa } : {};
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
    return (ev) => ({ home: pick(ev.home_team), away: pick(ev.away_team), of: stats.count, through: stats.through, season: stats.season });
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

// ---------- Ask Edge: real-time Q&A about the current board ----------
const ASK_MODEL = process.env.ANTHROPIC_CHAT_MODEL || AI_MODEL;
const ASK_LIMIT_PER_MIN = Number(process.env.ASK_PER_MINUTE) || 6;
const ASK_LIMIT_PER_DAY = Number(process.env.ASK_PER_DAY) || 60;
const ASK_HORIZON_DAYS = Number(process.env.ASK_HORIZON_DAYS) || 7; // how far ahead Ask Edge can see
const ASK_MAX_BETS = 700; // keeps each question small and cheap even on a busy week
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

// Everything the assistant is allowed to know, as compact text, plus a lookup table for the pricing tool.
// Rebuilt at most once a minute per sport.
function askContext(sport) {
  return cached(`askctx:${sport}`, 60e3, async () => {
    const boards = await Promise.all(PICK_MARKETS.map((m) => getOdds(sport, m).catch(() => null)));
    const events = mergeBoards(boards);
    const r = globalThis.EdgePicks.analyze(events, { markets: PICK_MARKETS, horizonHours: ASK_HORIZON_DAYS * 24, maxSingles: 6, maxParlays: 3 });
    // Keep only each game's main line per bet type (the number most sportsbooks are offering), soonest games first.
    const mainLine = new Map();
    for (const x of r.sides) {
      const k = `${x.eventId}|${x.market}`;
      if (!mainLine.has(k) || x.books > mainLine.get(k).books) mainLine.set(k, { line: x.line, books: x.books });
    }
    let kept = r.sides.filter((x) => mainLine.get(`${x.eventId}|${x.market}`).line === x.line)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    let cutoff = null;
    if (kept.length > ASK_MAX_BETS) { cutoff = kept[ASK_MAX_BETS].start; kept = kept.filter((x) => x.start < cutoff); }
    r.sides = kept;
    const titles = {};
    for (const ev of events) for (const b of ev.bookmakers) titles[b.key] = b.title;
    const epa = await soon(epaFinder(sport), 800);
    const byGame = new Map();
    for (const x of r.sides) { if (!byGame.has(x.eventId)) byGame.set(x.eventId, []); byGame.get(x.eventId).push(x); }
    const ids = {};
    const lines = [];
    let gi = 0, si = 0;
    for (const ev of events) {
      const sides = byGame.get(ev.id);
      if (!sides) continue;
      gi++;
      const w = await soon(weatherFor(sport, ev), 300);
      const wx = !w ? '' : w.type === 'indoor' ? ' | Indoors' : w.tempF != null ? ` | Weather ${w.tempF}F, wind ${w.windMph} mph, ${w.rainPct || 0}% precip${w.type === 'retractable' ? ', retractable roof' : ''}` : '';
      const e = epa ? epa(ev) : null;
      const ep = e && e.home && e.away ? ` | Team EPA/play (net, rank of ${e.of}): ${ev.away_team} ${e.away.net.toFixed(2)} #${e.away.netRank}, ${ev.home_team} ${e.home.net.toFixed(2)} #${e.home.netRank}` : '';
      lines.push(`GAME ${ev.away_team} @ ${ev.home_team} | ${etTime(ev.commence_time)} ET${wx}${ep}`);
      for (const x of sides.sort((a, b) => a.market.localeCompare(b.market))) {
        const id = `S${++si}`; // each game's main line only
        ids[id] = x;
        lines.push(`  ${id} ${x.market === 'h2h' ? 'Moneyline' : x.market === 'spreads' ? 'Spread' : 'Total'}: ${x.pick} | best ${x.bestOdds} at ${x.best.title} | fair chance ${(x.fair * 100).toFixed(1)}% (fair price ${x.fairOdds}) | edge ${(x.edge * 100).toFixed(1)}% | ${x.books} books`);
      }
    }
    const soonest = globalThis.EdgePicks.analyze(events, { markets: PICK_MARKETS, maxSingles: 6, maxParlays: 3 });
    const idOf = (x) => Object.keys(ids).find((k) => { const y = ids[k]; return y.eventId === x.eventId && y.market === x.market && y.pick === x.pick; }) || '';
    r.singles = soonest.singles; r.parlays = soonest.parlays;
    const top = r.singles.filter((x) => idOf(x)).map((x) => `${idOf(x)} ${x.pick} ${x.bestOdds} at ${x.best.title} (edge ${(x.edge * 100).toFixed(1)}%)`).join('; ');
    const tp = r.parlays.map((p) => `${p.legs.map((l) => l.pick).join(' + ')} at ${p.title} ${p.odds}, hits ${(p.hit * 100).toFixed(1)}%, edge ${(p.ev * 100).toFixed(1)}%`).join('; ');
    const through = cutoff ? `games starting before ${etTime(cutoff)} ET` : `the next ${ASK_HORIZON_DAYS} days`;
    const text = `${lines.join('\n')}\n\nSITE'S TOP SINGLES (next 36 hours): ${top || 'none'}\nSITE'S TOP PARLAYS (next 36 hours): ${tp || 'none'}`;
    return { text, ids, titles, games: gi, through, at: new Date().toISOString() };
  });
}

const ASK_TOOLS = [{
  name: 'price_bet',
  description: 'Price one bet or a parlay using bet IDs from the data (like S3, S7). Returns which licensed sportsbook pays the most for ALL the legs together, the American odds, what the stake returns, the chance every leg wins, and the edge. Always use this for parlay or payout math instead of calculating yourself.',
  input_schema: {
    type: 'object',
    properties: {
      legs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'Bet IDs, e.g. ["S3","S7"]' },
      stake: { type: 'number', description: 'Dollars bet. Default 10.' },
    },
    required: ['legs'],
  },
}];

function priceBet(ctx, input) {
  const stake = Number(input.stake) > 0 ? Number(input.stake) : 10;
  const legs = (input.legs || []).map((id) => ({ id, side: ctx.ids[String(id).toUpperCase()] }));
  const missing = legs.filter((l) => !l.side).map((l) => l.id);
  if (missing.length) return { error: `Unknown bet IDs: ${missing.join(', ')}. Use IDs from the data.` };
  const games = new Set(legs.map((l) => l.side.eventId));
  const warning = games.size < legs.length ? 'Two or more legs are from the same game. Many sportsbooks will not allow that, or they price it differently (same-game parlay), so these numbers are only a rough guide.' : null;
  const books = Object.keys(legs[0].side.offers).filter((b) => legs.every((l) => l.side.offers[b]));
  if (!books.length) return { error: 'No single licensed sportsbook offers every one of these legs at the same line, so this parlay cannot be placed as one bet.' };
  const options = books.map((b) => {
    const dec = legs.reduce((p, l) => p * l.side.offers[b], 1);
    return { sportsbook: ctx.titles[b] || b, odds: globalThis.EdgePicks.fmtAmerican(dec), returns: +(stake * dec).toFixed(2), dec };
  }).sort((a, b) => b.dec - a.dec);
  const hit = legs.reduce((p, l) => p * l.side.fair, 1);
  const best = options[0];
  return {
    legs: legs.map((l) => `${l.side.pick} (${l.side.game})`),
    stake, best_sportsbook: best.sportsbook, odds: best.odds, total_return: best.returns, profit_if_it_wins: +(best.returns - stake).toFixed(2),
    chance_all_legs_win: `${(hit * 100).toFixed(1)}% (about 1 in ${Math.max(1, Math.round(1 / hit))})`,
    edge: `${((hit * best.dec - 1) * 100).toFixed(1)}%`,
    other_sportsbooks: options.slice(1, 4).map(({ dec, ...o }) => o),
    ...(warning ? { warning } : {}),
  };
}

function askSystem(sport, ctx) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `You are Edge, the betting assistant on the Edge odds comparison website. Today is ${today}. The user is looking at ${SPORT_NAMES[sport] || sport}.

You answer using ONLY the data below, which the site calculated from live sportsbook prices at ${etTime(ctx.at)} ET.
- "fair chance" = all sportsbooks' prices combined, with each book's built-in cut removed. It is the market's estimate, not a separate prediction.
- "best" = the best price at a licensed US sportsbook. "fair price" = the odds matching the fair chance exactly.
- "edge" = how the best price compares with the fair chance. Positive is a bargain; negative is what the sportsbook keeps on average.

How to answer:
- Be short and plain, so a 5th grader could follow: usually 2 to 6 sentences or a short dash list. Plain text, no markdown headers, tables, or bold.
- Copy prices and sportsbook names exactly. For any parlay or payout question, call the price_bet tool with bet IDs. Never do parlay math yourself. Do not show bet IDs (like S3) to the user.
- "Best bet" means the best price compared with the fair chance, not a sure winner. Say the chance of winning when you recommend something. Never promise a win or call anything a lock or guaranteed.
- You only see odds plus the weather and team EPA shown here. You do not know injuries, lineups, news, player stats, records, or trends. If asked, say so and suggest checking the latest news.
- Only the games listed are available (${ctx.through}; live games are not included). Games further out may not have prices yet. If asked about anything else, say it is not on the board right now.
- A parlay must be placed at one sportsbook. Legs from the same game are usually not allowed as a normal parlay.
- If someone mentions chasing losses, betting money they need, or feeling out of control, be kind, suggest taking a break, and share the 1-800-GAMBLER helpline.
- Stay on sports betting and this site. Politely decline unrelated requests.

DATA (${ctx.games} games):
${ctx.text}`;
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

async function answerQuestion(sport, history, question) {
  const ctx = await askContext(sport);
  const system = askSystem(sport, ctx);
  const messages = [...history, { role: 'user', content: question }];
  let usageIn = 0, usageOut = 0;
  for (let step = 0; step < 4; step++) {
    const out = await claude({ model: ASK_MODEL, max_tokens: 1500, system, tools: ASK_TOOLS, messages });
    usageIn += out.usage?.input_tokens || 0; usageOut += out.usage?.output_tokens || 0;
    if (out.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: out.content });
      messages.push({
        role: 'user',
        content: out.content.filter((b) => b.type === 'tool_use').map((b) => ({
          type: 'tool_result', tool_use_id: b.id,
          content: JSON.stringify(b.name === 'price_bet' ? priceBet(ctx, b.input || {}) : { error: 'Unknown tool' }),
        })),
      });
      continue;
    }
    const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    console.log(`[ask] ${sport}: ${usageIn} in / ${usageOut} out tokens, ${step} tool call${step === 1 ? '' : 's'}`);
    return { text: text || 'Sorry, I could not come up with an answer. Try asking another way.', at: ctx.at };
  }
  return { text: 'That took too many steps. Try a simpler question.', at: ctx.at };
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
    const [epa, weather] = await Promise.all([
      soon(epaFinder(sport)),
      Promise.all(body.events.map((ev) => soon(weatherFor(sport, ev)))),
    ]);
    const events = body.events.map((ev, i) => ({ ...ev, weather: weather[i], epa: epa ? epa(ev) : null }));
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
    const sport = body.sport;
    const question = String(body.question || '').trim().slice(0, 600);
    if (!MAJOR_SPORTS.has(sport) || !question) return sendJSON(res, 400, { error: 'bad_request' });
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
      return sendJSON(res, 200, await answerQuestion(sport, history, question));
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
    const entry = cache.get(`props:${event}:${market}`);
    const refreshing = Boolean(entry?.inflight) || (entry && Date.now() - entry.at >= entry.ttl);
    return sendJSON(res, 200, { ...pub, refreshing });
  }

  return sendJSON(res, 404, { error: 'not_found' });
}

// Props create one cache entry per game+market; drop ones nobody has asked for in a while.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of cache) if (/^(props|wx|espn|ai|askctx):/.test(k) && v.at < cutoff && !v.inflight) cache.delete(k);
}, 15 * 60 * 1000).unref();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function handleStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html';
  if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
  try {
    const file = await readFile(join(ROOT, rel));
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
});
