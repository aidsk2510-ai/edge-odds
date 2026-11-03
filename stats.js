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

// Box score files are big, so keep them in memory: last season never changes; this season refreshes every 30 min.
const boxMemo = new Map();
function readPlayerBox(season) {
  const live = season >= nbaSeason();
  const hit = boxMemo.get(season);
  if (hit && (!live || Date.now() - hit.at < 30 * 60e3)) return hit.p;
  const p = readPlayerBoxRaw(season).catch((e) => { boxMemo.delete(season); throw e; });
  boxMemo.set(season, { at: Date.now(), p });
  return p;
}
async function readPlayerBoxRaw(season) {
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
      opp: r[cols.opponent_team_abbreviation], oppName: r[cols.opponent_team_display_name], home: r[cols.home_away] === 'home',
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

// ---------- Prop model inputs ----------
export const nameKey = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');
export const posGroupNba = (pos) => (/C/.test(pos || '') ? 'big' : /F/.test(pos || '') ? 'wing' : 'guard');
const NBA_STATS = ['pts', 'reb', 'ast', 'tpm'];

// Builds a lookup of how many points/rebounds/assists/threes each defense allows to guards, wings and bigs.
function defenseTable(games, groupOf, stats, K) {
  // games: Map oppTeam -> Map gameKey -> {group -> {stat -> total}}
  const per = {}, league = {};
  for (const [opp, byGame] of games) {
    per[opp] = {};
    for (const g of byGame.values()) for (const [grp, t] of Object.entries(g)) {
      const a = (per[opp][grp] ||= { n: 0 }); a.n++;
      for (const k of stats) a[k] = (a[k] || 0) + (t[k] || 0);
    }
  }
  for (const opp in per) for (const grp in per[opp]) {
    const a = per[opp][grp], L = (league[grp] ||= { n: 0 });
    L.n += a.n; for (const k of stats) L[k] = (L[k] || 0) + a[k];
  }
  const out = {};
  for (const opp in per) {
    out[opp] = {};
    for (const grp in per[opp]) {
      const a = per[opp][grp], L = league[grp];
      out[opp][grp] = { games: a.n };
      for (const k of stats) {
        const avg = L[k] / L.n, mine = a[k] / a.n;
        const raw = avg > 0 ? mine / avg : 1;
        out[opp][grp][k] = { perGame: mine, leagueAvg: avg, factor: (a.n * raw + K) / (a.n + K) }; // shrink toward average until there are enough games
      }
    }
  }
  // Rank 1 = allows the most.
  for (const grp of Object.keys(league)) for (const k of stats) {
    const list = Object.keys(out).filter((t) => out[t][grp]).sort((a, b) => out[b][grp][k].perGame - out[a][grp][k].perGame);
    list.forEach((t, i) => { out[t][grp][k].rank = i + 1; out[t][grp][k].of = list.length; });
  }
  return out;
}

export async function loadNbaPropData(season = nbaSeason()) {
  const [cur, prev] = await Promise.all([readPlayerBox(season), readPlayerBox(season - 1).catch(() => null)]);
  if (!cur?.rows.length) throw new Error('no box scores for this NBA season yet');
  const players = {}, teamDates = {}, teamGameIds = {}, teamTotals = {}, defGames = new Map();
  const logOf = (x) => ({ date: x.date, opp: x.opp, home: x.home, min: x.min, pts: x.pts, reb: x.reb, ast: x.ast, tpm: x.tpm, starter: x.starter });
  for (const x of cur.rows) {
    const k = nameKey(x.name);
    const p = (players[k] ||= { name: x.name, team: x.team, teamName: x.teamName, pos: x.pos, logs: [], prev: [], _d: '' });
    if (x.date >= p._d) Object.assign(p, { _d: x.date, team: x.team, teamName: x.teamName, pos: x.pos || p.pos });
    p.logs.push(logOf(x));
    (teamDates[x.team] ||= new Set()).add(x.date);
    (teamGameIds[x.team] ||= new Map()).set(x.game, x.date);
    const tt = (teamTotals[x.team] ||= { games: new Set(), pts: 0, reb: 0, ast: 0, tpm: 0 });
    tt.games.add(x.game); for (const s of NBA_STATS) tt[s] += x[s];
    const byGame = defGames.get(x.opp) || new Map(); defGames.set(x.opp, byGame);
    const g = byGame.get(x.game) || {}; byGame.set(x.game, g);
    const t = (g[posGroupNba(x.pos)] ||= {}); for (const s of NBA_STATS) t[s] = (t[s] || 0) + x[s];
  }
  if (prev) for (const x of prev.rows) { const p = players[nameKey(x.name)]; if (p) p.prev.push(logOf(x)); }
  // Who played in each team's most recent games (to tell a new absence from an old one).
  const recent = {};
  for (const [team, m] of Object.entries(teamGameIds)) {
    const last3 = [...m.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 3).map(([id]) => id);
    recent[team] = { games: last3, played: {} };
  }
  for (const x of cur.rows) { const r = recent[x.team]; if (r?.games.includes(x.game)) r.played[nameKey(x.name)] = (r.played[nameKey(x.name)] || 0) + 1; }
  for (const p of Object.values(players)) {
    p.logs.sort((a, b) => (a.date < b.date ? 1 : -1)); p.prev.sort((a, b) => (a.date < b.date ? 1 : -1)); p.prev = p.prev.slice(0, 25); delete p._d;
  }
  const teams = {};
  for (const [t, tt] of Object.entries(teamTotals)) {
    const n = tt.games.size;
    teams[t] = { games: n, perGame: Object.fromEntries(NBA_STATS.map((s) => [s, tt[s] / n])), dates: [...teamDates[t]].sort(), recent: recent[t] };
  }
  const names = {};
  for (const x of cur.rows) { names[x.teamName] = x.team; names[x.oppName] = x.opp; }
  return { sport: 'basketball_nba', through: cur.last, players, teams, names, defense: defenseTable(defGames, posGroupNba, NBA_STATS, 8) };
}

// ---------- NFL weekly player stats (nflverse) ----------
const NFL_STATS = ['pass_yds', 'pass_att', 'rush_yds', 'carries', 'rec', 'tgt', 'rec_yds'];
export const posGroupNfl = (pos) => (pos === 'QB' ? 'QB' : pos === 'RB' || pos === 'FB' ? 'RB' : pos === 'TE' ? 'TE' : 'WR');
async function readNflWeekly(season) {
  const res = await fetch(`${NFLVERSE}/stats_player/stats_player_week_${season}.csv`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`nflverse stats_player ${res.status}`);
  const rows = []; let cols = null;
  await streamCsv(Readable.fromWeb(res.body), (r) => {
    if (!cols) { cols = Object.fromEntries(r.map((name, i) => [name, i])); return; }
    if (r[cols.season_type] !== 'REG') return;
    const n = (k) => Number(r[cols[k]]) || 0;
    rows.push({
      id: r[cols.player_id], name: r[cols.player_display_name], pos: r[cols.position], team: r[cols.team], opp: r[cols.opponent_team], week: n('week'), game: r[cols.game_id],
      pass_yds: n('passing_yards'), pass_att: n('attempts'), rush_yds: n('rushing_yards'), carries: n('carries'), rec: n('receptions'), tgt: n('targets'), rec_yds: n('receiving_yards'),
    });
  });
  return rows;
}
const nflMemo = new Map();
function nflWeekly(season, live) {
  const hit = nflMemo.get(season);
  if (hit && (!live || Date.now() - hit.at < 2 * 3600e3)) return hit.p;
  const p = readNflWeekly(season).catch((e) => { nflMemo.delete(season); throw e; });
  nflMemo.set(season, { at: Date.now(), p });
  return p;
}

export async function loadNflPropData(season = footballSeason()) {
  const [cur, prev] = await Promise.all([nflWeekly(season, true), nflWeekly(season - 1, false).catch(() => null)]);
  if (!cur?.length) throw new Error('no NFL weekly stats for this season yet');
  const players = {}, teamTot = {}, defGames = new Map(), teamWeeks = {};
  const logOf = (x) => Object.fromEntries([['week', x.week], ['opp', x.opp], ...NFL_STATS.map((k) => [k, x[k]])]);
  let lastWeek = 0;
  for (const x of cur) {
    lastWeek = Math.max(lastWeek, x.week);
    const k = nameKey(x.name);
    const p = (players[k] ||= { name: x.name, pos: x.pos, team: x.team, logs: [], prev: [], _w: 0 });
    if (x.week >= p._w) Object.assign(p, { _w: x.week, team: x.team, pos: x.pos });
    p.logs.push(logOf(x));
    (teamWeeks[x.team] ||= new Set()).add(x.week);
    const tt = (teamTot[x.team] ||= { tgt: 0, carries: 0, weeks: new Set() }); tt.tgt += x.tgt; tt.carries += x.carries; tt.weeks.add(x.week);
    const byGame = defGames.get(x.opp) || new Map(); defGames.set(x.opp, byGame);
    const g = byGame.get(x.game) || {}; byGame.set(x.game, g);
    const t = (g[posGroupNfl(x.pos)] ||= {}); for (const s of NFL_STATS) t[s] = (t[s] || 0) + x[s];
  }
  if (prev) for (const x of prev) { const p = players[nameKey(x.name)]; if (p) p.prev.push(logOf(x)); }
  for (const p of Object.values(players)) {
    p.logs.sort((a, b) => b.week - a.week); p.prev.sort((a, b) => b.week - a.week); p.prev = p.prev.slice(0, 10);
    // Share of team targets and carries this season, and whether he played the team's latest game.
    const tt = teamTot[p.team]; const mine = p.logs.filter((l) => true);
    p.tgtShare = tt?.tgt ? mine.reduce((s, l) => s + l.tgt, 0) / tt.tgt : 0;
    p.carryShare = tt?.carries ? mine.reduce((s, l) => s + l.carries, 0) / tt.carries : 0;
    const lastTeamWeek = Math.max(...(teamWeeks[p.team] || [0]));
    p.playedLast = p.logs[0]?.week === lastTeamWeek;
    delete p._w;
  }
  const teams = {};
  for (const [t, tt] of Object.entries(teamTot)) teams[t] = { games: tt.weeks.size };
  const names = {};
  for (const [abbr, full] of Object.entries(NFL_TEAMS)) names[full] = abbr;
  return { sport: 'americanfootball_nfl', through: `Week ${lastWeek}`, players, teams, names, defense: defenseTable(defGames, posGroupNfl, NFL_STATS, 6) };
}
