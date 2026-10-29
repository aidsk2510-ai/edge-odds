// Team EPA (Expected Points Added) per play, for NFL and college football.
//  - NFL: computed from nflverse play-by-play (free, updated daily): https://github.com/nflverse/nflverse-data
//  - College: CollegeFootballData.com season advanced stats (free key, set CFBD_API_KEY). They call EPA "PPA".
// Offense EPA/play: higher is better. Defense EPA/play allowed: lower is better. Net = offense - defense.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { normalize } from './venues.js';

const NFLVERSE = (process.env.NFLVERSE_BASE || 'https://github.com/nflverse/nflverse-data/releases/download').replace(/\/$/, '');
const CFBD = (process.env.CFBD_API_BASE || 'https://api.collegefootballdata.com').replace(/\/$/, '');

const NFL_TEAMS = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers',
  CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos',
  DET: 'Detroit Lions', GB: 'Green Bay Packers', HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs', LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers', LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets',
  PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

// Football seasons run Sep–Feb, so January/February games belong to the previous year's season.
export const footballSeason = (d = new Date()) => (d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear());

// Streaming CSV reader (handles quoted fields with commas, quotes and newlines). Calls onRow(array) per record.
async function streamCsv(readable, onRow) {
  let field = '', row = [], inQuotes = false, quotePending = false;
  for await (const chunk of readable) {
    const s = chunk.toString('utf8');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (quotePending) {
          quotePending = false;
          if (c === '"') { field += '"'; continue; }
          inQuotes = false; // fall through: the quote closed the field
        } else if (c === '"') { quotePending = true; continue; }
        else { field += c; continue; }
      }
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); onRow(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (quotePending) inQuotes = false;
  if (field || row.length) { row.push(field); onRow(row); }
}

function rank(list, key, desc) {
  const sorted = [...list].sort((a, b) => (desc ? b[key] - a[key] : a[key] - b[key]));
  sorted.forEach((t, i) => { t[key + 'Rank'] = i + 1; });
}

export async function loadNflEpa(season = footballSeason()) {
  const res = await fetch(`${NFLVERSE}/pbp/play_by_play_${season}.csv.gz`);
  if (!res.ok) throw new Error(`nflverse ${res.status}`);
  const totals = {}; // team -> { op, oe, dp, de }
  let cols = null, maxWeek = 0;
  await streamCsv(Readable.fromWeb(res.body).pipe(createGunzip()), (r) => {
    if (!cols) { cols = Object.fromEntries(r.map((name, i) => [name, i])); return; }
    const type = r[cols.play_type], epa = r[cols.epa];
    if ((type !== 'pass' && type !== 'run') || !epa || epa === 'NA' || r[cols.two_point_attempt] === '1') return;
    const e = Number(epa); if (!Number.isFinite(e)) return;
    const off = (totals[r[cols.posteam]] ||= { op: 0, oe: 0, dp: 0, de: 0 });
    const def = (totals[r[cols.defteam]] ||= { op: 0, oe: 0, dp: 0, de: 0 });
    off.op++; off.oe += e; def.dp++; def.de += e;
    maxWeek = Math.max(maxWeek, Number(r[cols.week]) || 0);
  });
  const teams = Object.entries(totals).filter(([abbr, t]) => NFL_TEAMS[abbr] && t.op && t.dp).map(([abbr, t]) => ({
    name: NFL_TEAMS[abbr], off: t.oe / t.op, def: t.de / t.dp, net: t.oe / t.op - t.de / t.dp, plays: t.op,
  }));
  rank(teams, 'net', true); rank(teams, 'off', true); rank(teams, 'def', false);
  return { season, through: maxWeek ? `Week ${maxWeek}` : null, count: teams.length, teams };
}

export async function loadCfbEpa(season = footballSeason()) {
  const key = process.env.CFBD_API_KEY;
  if (!key) return null;
  const res = await fetch(`${CFBD}/stats/season/advanced?year=${season}&excludeGarbageTime=true`, {
    headers: { Authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CFBD ${res.status}`);
  const teams = (await res.json())
    .filter((t) => Number.isFinite(t.offense?.ppa) && Number.isFinite(t.defense?.ppa))
    .map((t) => ({ name: t.team, off: t.offense.ppa, def: t.defense.ppa, net: t.offense.ppa - t.defense.ppa, plays: t.offense.plays }));
  rank(teams, 'net', true); rank(teams, 'off', true); rank(teams, 'def', false);
  return { season, through: null, count: teams.length, teams };
}

// Odds feeds and stats sites spell some schools differently.
const ALIASES = [
  ['appalachian state', 'app state'], ['louisiana monroe', 'ul monroe'], ['southern mississippi', 'southern miss'],
  ['connecticut', 'uconn'], ['massachusetts', 'umass'], ['fiu', 'florida international'], ['north carolina state', 'nc state'],
  ['mississippi', 'ole miss'], ['sam houston state', 'sam houston'], ['louisiana lafayette', 'louisiana'], ['ul lafayette', 'louisiana'],
  ['texas san antonio', 'utsa'], ['central florida', 'ucf'], ['southern california', 'usc'], ['brigham young', 'byu'],
  ['southern methodist', 'smu'], ['texas christian', 'tcu'], ['louisiana state', 'lsu'], ['alabama birmingham', 'uab'],
  ['nevada las vegas', 'unlv'], ['texas el paso', 'utep'], ['miami fl', 'miami'], ['miami ohio', 'miami oh'], ['hawaii', 'hawai i'],
  ['middle tennessee state', 'middle tennessee'], ['san jose state', 'san jose state'], ['western kentucky', 'western kentucky'],
];
const ALIAS = new Map();
for (const [a, b] of ALIASES) { ALIAS.set(a, b); ALIAS.set(b, a); }

// Build a matcher: team name from the odds feed -> stats row (longest name prefix wins, so mascots are ignored).
export function indexTeams(stats) {
  const map = new Map();
  for (const t of stats?.teams || []) {
    map.set(normalize(t.name), t);
    map.set(normalize(t.name.replace(/['‘’ʻ]/g, '')), t);
  }
  return (name) => {
    for (const variant of [name, name.replace(/['‘’ʻ]/g, '')]) {
      const words = normalize(variant).split(' ');
      for (let n = words.length; n > 0; n--) {
        const p = words.slice(0, n).join(' ');
        const hit = map.get(p) || map.get(ALIAS.get(p));
        if (hit) return hit;
      }
    }
    return null;
  };
}
