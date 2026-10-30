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

// ---------- Fantasy NBA: player box scores (sportsdataverse) ----------
// Returns per-player totals for three windows: this season, the last 14 days of it, and last season.
const BOX_KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pts', 'pf', 'pm', 'gs', 'dd', 'td', 'useP', 'useT'];
const emptyLine = () => Object.fromEntries([['gp', 0], ...BOX_KEYS.map((k) => [k, 0])]);

async function readPlayerBox(season) {
  const res = await fetch(`${SDV}/espn_nba_player_boxscores/player_box_${season}.csv`);
  if (res.status === 404) return null; // season file not published yet
  if (!res.ok) throw new Error(`sportsdataverse players ${res.status}`);
  const rows = [];
  let cols = null;
  await streamCsv(Readable.fromWeb(res.body), (r) => {
    if (!cols) { cols = Object.fromEntries(r.map((name, i) => [name, i])); return; }
    if (r[cols.season_type] !== '2') return; // regular season only
    const n = (k) => Number(r[cols[k]]) || 0;
    const min = n('minutes');
    if (r[cols.did_not_play] === 'true' || min <= 0) return;
    rows.push({
      game: r[cols.game_id], date: r[cols.game_date], id: r[cols.athlete_id], name: r[cols.athlete_display_name],
      team: r[cols.team_abbreviation], teamName: r[cols.team_display_name], color: r[cols.team_color], pos: r[cols.athlete_position_abbreviation],
      starter: r[cols.starter] === 'true',
      min, fgm: n('field_goals_made'), fga: n('field_goals_attempted'), tpm: n('three_point_field_goals_made'), tpa: n('three_point_field_goals_attempted'),
      ftm: n('free_throws_made'), fta: n('free_throws_attempted'), oreb: n('offensive_rebounds'), reb: n('rebounds'), ast: n('assists'),
      stl: n('steals'), blk: n('blocks'), tov: n('turnovers'), pts: n('points'), pf: n('fouls'), pm: Number(String(r[cols.plus_minus]).replace('+', '')) || 0,
    });
  });
  // Team totals per game, for usage rate.
  const tg = new Map();
  for (const x of rows) {
    const k = x.game + '|' + x.team;
    const t = tg.get(k) || { min: 0, use: 0 };
    t.min += x.min; t.use += x.fga + 0.44 * x.fta + x.tov;
    tg.set(k, t);
  }
  const teamGames = {};
  for (const k of tg.keys()) { const team = k.split('|')[1]; teamGames[team] = (teamGames[team] || 0) + 1; }
  let last = '';
  for (const x of rows) if (x.date > last) last = x.date;
  return { rows, tg, teamGames, last };
}

function addGame(line, x, tg) {
  const t = tg.get(x.game + '|' + x.team);
  line.gp++;
  for (const k of ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pts', 'pf', 'pm']) line[k] += x[k];
  if (x.starter) line.gs++;
  const tens = [x.pts, x.reb, x.ast, x.stl, x.blk].filter((v) => v >= 10).length;
  if (tens >= 2) line.dd++;
  if (tens >= 3) line.td++;
  line.useP += x.fga + 0.44 * x.fta + x.tov;
  if (t && t.min > 0) line.useT += (t.use * x.min) / (t.min / 5); // team plays used while he was on the floor
}

const round = (line) => { for (const k in line) line[k] = Math.round(line[k] * 10) / 10; return line; };

export async function loadNbaPlayers(season = nbaSeason()) {
  const [cur, prev] = await Promise.all([readPlayerBox(season), readPlayerBox(season - 1)]);
  if (!cur && !prev) throw new Error('no NBA player box scores found');
  const players = new Map();
  const get = (x) => {
    let p = players.get(x.id);
    if (!p) players.set(x.id, (p = { id: x.id, name: x.name, team: x.team, teamName: x.teamName, color: x.color, pos: x.pos, cur: emptyLine(), l14: emptyLine(), prev: emptyLine(), _d: '' }));
    if (x.date >= p._d) Object.assign(p, { _d: x.date, team: x.team, teamName: x.teamName, color: x.color, pos: x.pos || p.pos, name: x.name });
    return p;
  };
  if (prev) for (const x of prev.rows) addGame(get(x).prev, x, prev.tg);
  let cutoff = '';
  if (cur) {
    const d = new Date(cur.last + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 13);
    cutoff = d.toISOString().slice(0, 10);
    for (const x of cur.rows) { const p = get(x); addGame(p.cur, x, cur.tg); if (x.date >= cutoff) addGame(p.l14, x, cur.tg); }
  }
  const out = [...players.values()].map(({ _d, ...p }) => ({ ...p, lastGame: _d, cur: round(p.cur), l14: round(p.l14), prev: round(p.prev) }));
  const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const teams = {};
  for (const p of out) teams[p.team] ||= { abbr: p.team, name: p.teamName, color: p.color, gp: cur?.teamGames[p.team] || 0 };
  return {
    season: `${season - 1}-${String(season).slice(2)}`, prevSeason: `${season - 2}-${String(season - 1).slice(2)}`,
    through: cur?.last ? fmt(cur.last) : null, l14From: cutoff ? fmt(cutoff) : null,
    hasCurrent: Boolean(cur?.rows.length), teams, players: out,
  };
}
