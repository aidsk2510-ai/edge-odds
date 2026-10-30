// Team EPA (Expected Points Added) per play, for NFL and college football.
//  - NFL: computed from nflverse play-by-play (free, updated daily): https://github.com/nflverse/nflverse-data
//  - College: CollegeFootballData.com season advanced stats (free key, set CFBD_API_KEY). They call EPA "PPA".
// Offense EPA/play: higher is better. Defense EPA/play allowed: lower is better. Net = offense - defense.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { normalize } from './venues.js';

const NFLVERSE = (process.env.NFLVERSE_BASE || 'https://github.com/nflverse/nflverse-data/releases/download').replace(/\/$/, '');
const CFBD = (process.env.CFBD_API_BASE || 'https://api.collegefootballdata.com').replace(/\/$/, '');
const ESPN_INJ = (process.env.ESPN_API_BASE || 'https://site.api.espn.com').replace(/\/$/, '');
const SDV = (process.env.SPORTSDATAVERSE_BASE || 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download').replace(/\/$/, '');

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

// Streaming CSV reader. Most lines have no quotes and go through a fast native split; lines with quoted
// fields (commas, quotes or newlines inside) use a careful parser. Calls onRow(array) per record.
function parseQuoted(line) {
  const out = []; let field = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

async function streamCsv(readable, onRow) {
  readable.setEncoding('utf8'); // decodes multi-byte characters safely across chunk boundaries
  let rest = '', pending = '';
  const emit = (raw) => {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (pending) { line = pending + '\n' + line; pending = ''; }
    if (line.indexOf('"') === -1) return onRow(line.split(','));
    let quotes = 0;
    for (let i = line.indexOf('"'); i !== -1; i = line.indexOf('"', i + 1)) quotes++;
    if (quotes % 2) { pending = line; return; } // a quoted field continues on the next line
    onRow(parseQuoted(line));
  };
  for await (const chunk of readable) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const l of lines) emit(l);
  }
  if (rest) emit(rest);
  if (pending) onRow(parseQuoted(pending));
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
  return { kind: 'epa', season, through: maxWeek ? `Week ${maxWeek}` : null, count: teams.length, teams };
}

// NBA seasons are named by the year they end: the 2026-27 season is "2027".
export const nbaSeason = (d = new Date()) => (d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear());

// NBA Offensive / Defensive / Net Rating (points per 100 possessions), from ESPN team box scores
// published by sportsdataverse (free, updated daily). Possessions per team per game:
//   shots attempted - offensive rebounds + turnovers + 0.44 x free throws attempted,
// averaged between the two teams (the standard estimate).
export async function loadNbaRatings(season = nbaSeason()) {
  const res = await fetch(`${SDV}/espn_nba_team_boxscores/team_box_${season}.csv`);
  if (!res.ok) throw new Error(`sportsdataverse ${res.status}`);
  const games = new Map();
  let cols = null, lastDate = '';
  await streamCsv(Readable.fromWeb(res.body), (r) => {
    if (!cols) { cols = Object.fromEntries(r.map((name, i) => [name, i])); return; }
    if (r[cols.season_type] === '1') return; // skip preseason
    const n = (k) => Number(r[cols[k]]) || 0;
    const row = { team: r[cols.team_display_name], pts: n('team_score'), poss: n('field_goals_attempted') - n('offensive_rebounds') + n(cols.total_turnovers != null ? 'total_turnovers' : 'turnovers') + 0.44 * n('free_throws_attempted') };
    if (!row.team) return;
    if (!games.has(r[cols.game_id])) games.set(r[cols.game_id], []);
    games.get(r[cols.game_id]).push(row);
    if (r[cols.game_date] > lastDate) lastDate = r[cols.game_date];
  });
  const totals = {};
  for (const pair of games.values()) {
    if (pair.length !== 2 || !pair[0].pts || !pair[1].pts) continue;
    const poss = (pair[0].poss + pair[1].poss) / 2;
    for (const [me, op] of [[pair[0], pair[1]], [pair[1], pair[0]]]) {
      const t = (totals[me.team] ||= { pts: 0, opp: 0, poss: 0, g: 0 });
      t.pts += me.pts; t.opp += op.pts; t.poss += poss; t.g++;
    }
  }
  const teams = Object.entries(totals).filter(([, t]) => t.poss > 0).map(([name, t]) => ({
    name, off: (100 * t.pts) / t.poss, def: (100 * t.opp) / t.poss, net: (100 * (t.pts - t.opp)) / t.poss, games: t.g,
  }));
  rank(teams, 'net', true); rank(teams, 'off', true); rank(teams, 'def', false);
  const through = lastDate ? `games through ${new Date(lastDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : null;
  return { kind: 'rating', season: `${season - 1}-${String(season).slice(2)}`, through, count: teams.length, teams };
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
  return { kind: 'epa', season, through: null, count: teams.length, teams };
}

// ---------- Injuries ----------
// Shape returned by both loaders: { source, updated, teams: [{ name, players: [{ player, pos, status, injury, note, returns }] }] }
const SERIOUS = /^(out|doubtful|questionable|day-to-day|suspension|injured reserve|ir)/i;

// NFL: the official league injury report, published by nflverse (updates as teams file reports, usually Wed-Sat).
export async function loadNflInjuries(season = footballSeason()) {
  const res = await fetch(`${NFLVERSE}/injuries/injuries_${season}.csv`);
  if (!res.ok) throw new Error(`nflverse injuries ${res.status}`);
  const updated = res.headers.get('last-modified');
  const rows = [];
  let cols = null, maxWeek = 0;
  await streamCsv(Readable.fromWeb(res.body), (r) => {
    if (!cols) { cols = Object.fromEntries(r.map((name, i) => [name, i])); return; }
    const week = Number(r[cols.week]) || 0;
    rows.push({ week, team: r[cols.team], player: r[cols.full_name], pos: r[cols.position], status: r[cols.report_status], injury: [r[cols.report_primary_injury], r[cols.report_secondary_injury]].filter(Boolean).join(', '), practice: r[cols.practice_status] });
    maxWeek = Math.max(maxWeek, week);
  });
  const byTeam = new Map();
  const reported = new Set(); // teams that have filed this week's report (even if nobody is listed)
  for (const x of rows) {
    if (x.week === maxWeek && NFL_TEAMS[x.team]) reported.add(NFL_TEAMS[x.team]);
    // Before the Friday game-status report, use the practice report (who missed or was limited).
    if (!x.status && /did not participate/i.test(x.practice || '')) x.status = 'Missed practice';
    else if (!x.status && /limited/i.test(x.practice || '')) x.status = 'Limited in practice';
    if (x.week !== maxWeek || !x.status || !NFL_TEAMS[x.team]) continue;
    const name = NFL_TEAMS[x.team];
    if (!byTeam.has(name)) byTeam.set(name, []);
    byTeam.get(name).push({ player: x.player, pos: x.pos, status: x.status, injury: x.injury || null, note: x.practice || null, returns: null });
  }
  return { source: `Official NFL injury report, Week ${maxWeek}`, updated, week: maxWeek, reported: [...reported], teams: [...byTeam.entries()].map(([name, players]) => ({ name, players })) };
}

// NBA / NHL / MLB / WNBA: ESPN's public injury list (unofficial, updates through the day).
export async function loadEspnInjuries(path) {
  const res = await fetch(`${ESPN_INJ}/apis/site/v2/sports/${path}/injuries`);
  if (!res.ok) throw new Error(`ESPN injuries ${res.status}`);
  const body = await res.json();
  const teams = [];
  for (const t of body.injuries || []) {
    const name = t.displayName || t.team?.displayName || t.team?.name;
    if (!name) continue;
    const players = [];
    for (const i of t.injuries || []) {
      const status = i.status || i.type?.description || i.details?.fantasyStatus?.description;
      if (!status || !SERIOUS.test(status)) continue;
      const d = i.details || {};
      const injury = [d.side && d.side !== 'Not Specified' ? d.side : null, d.location, d.type].filter(Boolean).join(' ') || null;
      players.push({
        player: i.athlete?.displayName || i.athlete?.fullName || 'Unknown player', pos: i.athlete?.position?.abbreviation || null,
        status, injury, note: i.shortComment || null, returns: d.returnDate || null,
      });
    }
    if (players.length) teams.push({ name, players });
  }
  if (!body.injuries) console.warn(`[injuries] ESPN ${path}: unexpected response shape (no "injuries" list)`);
  return { source: 'ESPN injury report', updated: new Date().toUTCString(), teams };
}

// Odds feeds and stats sites spell some schools differently.
const ALIASES = [
  ['appalachian state', 'app state'], ['louisiana monroe', 'ul monroe'], ['southern mississippi', 'southern miss'],
  ['connecticut', 'uconn'], ['massachusetts', 'umass'], ['fiu', 'florida international'], ['north carolina state', 'nc state'],
  ['mississippi', 'ole miss'], ['sam houston state', 'sam houston'], ['louisiana lafayette', 'louisiana'], ['ul lafayette', 'louisiana'],
  ['texas san antonio', 'utsa'], ['central florida', 'ucf'], ['southern california', 'usc'], ['brigham young', 'byu'],
  ['southern methodist', 'smu'], ['texas christian', 'tcu'], ['louisiana state', 'lsu'], ['alabama birmingham', 'uab'],
  ['nevada las vegas', 'unlv'], ['texas el paso', 'utep'], ['miami fl', 'miami'], ['miami ohio', 'miami oh'], ['hawaii', 'hawai i'],
  ['middle tennessee state', 'middle tennessee'], ['los angeles clippers', 'la clippers'], ['san jose state', 'san jose state'], ['western kentucky', 'western kentucky'],
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
