// Edge — live odds comparison server
// Zero dependencies. Requires Node 18+ (global fetch).
//
// Proxies The Odds API (https://the-odds-api.com), keeps the API key on the
// server, and caches responses so every visitor shares the same upstream call.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const API_BASE = (process.env.ODDS_API_BASE || 'https://api.the-odds-api.com').replace(/\/$/, '');
const REGIONS = process.env.ODDS_REGIONS || 'us,us2';
const ODDS_TTL = (Number(process.env.CACHE_SECONDS) || 60) * 1000;
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

const cache = new Map(); // key -> { at, body, inflight }

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
  return {
    data: await res.json(),
    quota: {
      remaining: res.headers.get('x-requests-remaining'),
      used: res.headers.get('x-requests-used'),
    },
  };
}

// Cache with in-flight de-duplication: concurrent visitors trigger one upstream call.
async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit?.body && Date.now() - hit.at < ttl) return hit.body;
  if (hit?.inflight) return hit.inflight;
  const inflight = loader()
    .then((body) => { cache.set(key, { at: Date.now(), body }); return body; })
    .catch((e) => {
      // Serve stale data if we have it rather than failing the page.
      if (hit?.body) { cache.set(key, hit); return { ...hit.body, stale: true }; }
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...hit, inflight });
  return inflight;
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

    const body = await cached(`odds:${sport}:${market}`, ODDS_TTL, async () => {
      const { data, quota } = await upstream(`/v4/sports/${sport}/odds`, {
        regions: REGIONS, markets: market, oddsFormat: 'decimal', dateFormat: 'iso',
      });
      return { fetchedAt: new Date().toISOString(), quota, events: data };
    });
    return sendJSON(res, 200, body, Math.floor(ODDS_TTL / 2000));
  }

  return sendJSON(res, 404, { error: 'not_found' });
}

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
