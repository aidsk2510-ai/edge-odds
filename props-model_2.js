// Edge prop model: projects a player's stat for one game, turns it into a chance of going over/under the line,
// and blends that with the sportsbooks' own (de-vigged) chance. Pure functions, no network.
import { nameKey, posGroupNba, posGroupNfl } from './stats.js';

export const PROP_SPECS = {
  basketball_nba: {
    player_points: { stats: ['pts'], label: 'points', short: 'PTS' },
    player_rebounds: { stats: ['reb'], label: 'rebounds', short: 'REB' },
    player_assists: { stats: ['ast'], label: 'assists', short: 'AST' },
    player_threes: { stats: ['tpm'], label: 'threes', short: '3PM', poisson: true },
    player_points_rebounds_assists: { stats: ['pts', 'reb', 'ast'], label: 'pts + reb + ast', short: 'PRA' },
  },
  americanfootball_nfl: {
    player_pass_yds: { stats: ['pass_yds'], label: 'passing yards', short: 'Pass yds', pos: ['QB'], skew: true },
    player_rush_yds: { stats: ['rush_yds'], label: 'rushing yards', short: 'Rush yds', skew: true },
    player_reception_yds: { stats: ['rec_yds'], label: 'receiving yards', short: 'Rec yds', skew: true },
    player_receptions: { stats: ['rec'], label: 'receptions', short: 'Rec' },
  },
};

const OUT_RE = /^(out|ir|injured reserve|suspension|doubtful)/i;
const Q_RE = /^(questionable|day-to-day)/i;
const MODEL_WEIGHT = 0.35; // how much our projection counts vs the market's price (books are sharp; we only nudge)

// ---------- math ----------
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function poissonCdf(k, lam) { // P(X <= k)
  let term = Math.exp(-lam), sum = term;
  for (let i = 1; i <= k; i++) { term *= lam / i; sum += term; }
  return Math.min(1, sum);
}
// Chance of Over (pushes on whole-number lines are ignored, like a refunded bet).
function overChance(line, mean, sd, poisson, skew) {
  if (skew && line > 0) { // yards: a few big games pull the average up, so the typical game is below it (log-normal)
    const s2 = Math.log(1 + (sd * sd) / (mean * mean)), mu = Math.log(mean) - s2 / 2;
    return 1 - Phi((Math.log(line) - mu) / Math.sqrt(s2));
  }
  if (poisson) {
    const lam = Math.max(0.05, mean);
    if (Number.isInteger(line)) { const over = 1 - poissonCdf(line, lam), under = poissonCdf(line - 1, lam); return over / (over + under); }
    return 1 - poissonCdf(Math.floor(line), lam);
  }
  if (Number.isInteger(line)) { const over = 1 - Phi((line + 0.5 - mean) / sd), under = Phi((line - 0.5 - mean) / sd); return over / (over + under); }
  return 1 - Phi((line - mean) / sd);
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sdOf = (a) => { if (a.length < 3) return 0; const m = avg(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const sum = (log, stats) => stats.reduce((s, k) => s + (log[k] || 0), 0);
const ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

// Weighted blend of available sources, renormalized over the ones that exist.
function blend(parts) {
  const ok = parts.filter((p) => p.w > 0 && Number.isFinite(p.v));
  const w = ok.reduce((s, p) => s + p.w, 0);
  return w ? ok.reduce((s, p) => s + p.v * p.w, 0) / w : null;
}

// ---------- NBA ----------
const GROUP_LABEL = { guard: 'guards', wing: 'forwards', big: 'centers', QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs' };

function projectNba(ctx, p, spec, game) {
  const logs = p.logs.filter((l) => l.min > 0), prev = p.prev.filter((l) => l.min > 0);
  const n = logs.length;
  if (!n && prev.length < 10) return null;
  const notes = [];
  const team = ctx.data.teams[p.team];
  // Minutes
  const mSeason = n ? avg(logs.map((l) => l.min)) : null, mL5 = n >= 3 ? avg(logs.slice(0, 5).map((l) => l.min)) : null, mPrev = prev.length ? avg(prev.map((l) => l.min)) : null;
  let minutes = mL5 != null ? 0.55 * mL5 + 0.45 * mSeason : mSeason ?? mPrev;
  if (mL5 != null && Math.abs(mL5 - mSeason) >= 3) notes.push({ t: `Playing ${r1(mL5)} min over his last 5 (season ${r1(mSeason)})`, good: mL5 > mSeason });
  // Back-to-back: his team played the day before this game.
  const gameDay = new Date(new Date(game.start).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const yday = new Date(gameDay.getTime() - 864e5).toISOString().slice(0, 10);
  if (team?.dates.includes(yday)) { minutes *= 0.96; notes.push({ t: 'Second night of a back-to-back', good: false }); }
  // Injured teammates: only new absences (he played in 2+ of the last 3 games) shift shots and minutes.
  const boost = { pts: 0, reb: 0, ast: 0, tpm: 0 };
  const grp = posGroupNba(p.pos);
  const mates = [];
  for (const inj of game.teamInjuries || []) {
    if (!OUT_RE.test(inj.status) || nameKey(inj.player) === nameKey(p.name)) continue;
    const mk = nameKey(inj.player), mate = ctx.data.players[mk];
    if (!mate || mate.team !== p.team) continue;
    const ml = mate.logs.filter((l) => l.min > 0);
    if (!ml.length || avg(ml.map((l) => l.min)) < 18) continue;
    if ((team?.recent?.played?.[mk] || 0) < 2) continue; // already missing: his absence is in the recent numbers
    for (const s of Object.keys(boost)) {
      const share = team.perGame[s] ? avg(ml.map((l) => l[s])) / team.perGame[s] : 0;
      boost[s] += (s === 'reb' && posGroupNba(mate.pos) !== grp ? 0.4 : 1) * share;
    }
    if (posGroupNba(mate.pos) === grp) minutes += Math.min(4, 0.15 * avg(ml.map((l) => l.min)));
    mates.push(inj.player);
  }
  if (mates.length) notes.push({ t: `${mates.join(', ')} ${mates.length > 1 ? 'are' : 'is'} out: more shots and minutes to go around`, good: true });
  // Per-stat projection
  let mean = 0;
  const matchup = [];
  for (const s of spec.stats) {
    const rate = (arr) => { const m = arr.reduce((x, l) => x + l.min, 0); return m ? arr.reduce((x, l) => x + l[s], 0) / m : NaN; };
    const perMin = blend([
      { v: rate(logs), w: n ? 0.45 * Math.min(1, n / 10) + 0.1 : 0 },
      { v: rate(logs.slice(0, 5)), w: n >= 3 ? 0.3 : 0 },
      { v: rate(prev), w: prev.length >= 10 ? 0.25 : 0 },
    ]);
    const d = ctx.data.defense[game.opp]?.[grp]?.[s];
    const f = d ? clamp(d.factor, 0.85, 1.15) : 1;
    if (d) matchup.push({ s, f, rank: d.rank, of: d.of });
    mean += perMin * minutes * f * (1 + Math.min(0.15, 0.45 * boost[s]));
  }
  // Matchup note for the main stat
  const m0 = matchup.sort((a, b) => Math.abs(b.f - 1) - Math.abs(a.f - 1))[0];
  if (m0 && Math.abs(m0.f - 1) >= 0.04) {
    const label = { pts: 'points', reb: 'rebounds', ast: 'assists', tpm: 'threes' }[m0.s];
    notes.push({ t: `${game.oppName} allow the ${m0.f > 1 ? ord(m0.rank) + '-most' : ord(m0.of - m0.rank + 1) + '-fewest'} ${label} to ${GROUP_LABEL[grp]} (${m0.f > 1 ? '+' : ''}${Math.round((m0.f - 1) * 100)}% vs average)`, good: m0.f > 1 });
  }
  const recent = [...logs, ...prev].slice(0, 20).map((l) => sum(l, spec.stats));
  const sd = Math.max(sdOf(recent), Math.sqrt(Math.max(1, mean)) * 1.05, spec.stats.includes('pts') ? 0.2 * mean : 0);
  const fresh = n >= 5;
  return { mean, sd, minutes, notes, sample: n, fresh, last10: [...logs, ...prev].slice(0, 10).map((l) => sum(l, spec.stats)), seasonAvg: n ? avg(logs.map((l) => sum(l, spec.stats))) : null, l5Avg: n >= 3 ? avg(logs.slice(0, 5).map((l) => sum(l, spec.stats))) : null, playedLast: !team?.dates?.length || p.logs[0]?.date === team.dates[team.dates.length - 1] };
}

// ---------- NFL ----------
function projectNfl(ctx, p, spec, game) {
  const s = spec.stats[0];
  const grp = posGroupNfl(p.pos);
  if (spec.pos && !spec.pos.includes(p.pos)) return null;
  const logs = p.logs, prev = p.prev, n = logs.length;
  if (!n && prev.length < 4) return null;
  const notes = [];
  let mean = blend([
    { v: avg(logs.map((l) => l[s])), w: n ? 0.4 * Math.min(1, n / 6) + 0.1 : 0 },
    { v: avg(logs.slice(0, 4).map((l) => l[s])), w: n >= 3 ? 0.4 : 0 },
    { v: avg(prev.map((l) => l[s])), w: prev.length >= 4 ? 0.15 : 0 },
  ]);
  if (mean == null || mean <= 0) return null;
  // Usage trend note
  if (n >= 5) {
    const key = s === 'pass_yds' ? 'pass_att' : s === 'rush_yds' ? 'carries' : 'tgt';
    const l3 = avg(logs.slice(0, 3).map((l) => l[key])), all = avg(logs.map((l) => l[key]));
    if (all > 0 && Math.abs(l3 - all) / all >= 0.2 && Math.abs(l3 - all) >= 1.5) notes.push({ t: `${r1(l3)} ${key === 'tgt' ? 'targets' : key === 'carries' ? 'carries' : 'pass attempts'} a game over his last 3 (season ${r1(all)})`, good: l3 > all });
  }
  // Matchup
  const d = ctx.data.defense[game.opp]?.[grp]?.[s];
  if (d) {
    const f = clamp(d.factor, 0.85, 1.15);
    mean *= f;
    const label = { pass_yds: 'passing yards', rush_yds: 'rushing yards', rec_yds: 'receiving yards', rec: 'catches' }[s];
    if (Math.abs(f - 1) >= 0.05) notes.push({ t: `${game.oppName} allow the ${f > 1 ? ord(d.rank) + '-most' : ord(d.of - d.rank + 1) + '-fewest'} ${label} to ${GROUP_LABEL[grp]} (${f > 1 ? '+' : ''}${Math.round((f - 1) * 100)}% vs average)`, good: f > 1 });
  }
  // Injured teammates (new absences only: they played the team's last game)
  let tgtFree = 0, carryFree = 0; const mates = []; let qbOut = false;
  for (const inj of game.teamInjuries || []) {
    if (!OUT_RE.test(inj.status) || nameKey(inj.player) === nameKey(p.name)) continue;
    const mate = ctx.data.players[nameKey(inj.player)];
    if (!mate || mate.team !== p.team || !mate.playedLast) continue;
    if (mate.pos === 'QB' && mate.logs.some((l) => l.pass_att >= 15)) { qbOut = true; mates.push(inj.player); continue; }
    if (mate.tgtShare >= 0.1) { tgtFree += mate.tgtShare; mates.push(inj.player); }
    else if (mate.carryShare >= 0.25) { carryFree += mate.carryShare; mates.push(inj.player); }
  }
  if ((s === 'rec' || s === 'rec_yds') && tgtFree) { mean *= 1 + Math.min(0.2, 0.5 * tgtFree); notes.push({ t: `${mates.join(', ')} out: about ${Math.round(tgtFree * 100)}% of the team's targets are up for grabs`, good: true }); }
  else if (s === 'rush_yds' && carryFree && grp === 'RB') { mean *= 1 + Math.min(0.35, 0.6 * carryFree); notes.push({ t: `${mates.join(', ')} out: more carries available`, good: true }); }
  if (qbOut && s !== 'rush_yds') { mean *= 0.9; notes.push({ t: 'Starting QB is out: backup QB', good: false }); }
  // Weather
  const w = game.weather;
  if (w && w.windMph != null && w.type !== 'indoor' && w.type !== 'dome' && (s === 'pass_yds' || s === 'rec_yds' || s === 'rec')) {
    const cut = w.windMph >= 20 ? 0.9 : w.windMph >= 15 ? 0.94 : (w.rainPct || 0) >= 70 ? 0.97 : 1;
    if (cut < 1) { mean *= s === 'rec' ? 1 - (1 - cut) / 2 : cut; notes.push({ t: `Weather: ${w.windMph} mph wind${(w.rainPct || 0) >= 50 ? `, ${w.rainPct}% chance of rain` : ''}`, good: false }); }
  }
  const recent = [...logs, ...prev].slice(0, 12).map((l) => l[s]);
  const floor = s === 'rec' ? Math.max(1, Math.sqrt(mean) * 0.9) : s === 'pass_yds' ? Math.max(30, 0.24 * mean) : Math.max(12, 0.38 * mean);
  const sd = Math.max(sdOf(recent), floor);
  return { mean, sd, notes, sample: n, fresh: n >= 3, last10: [...logs, ...prev].slice(0, 10).map((l) => l[s]), seasonAvg: n ? avg(logs.map((l) => l[s])) : null, l5Avg: n >= 3 ? avg(logs.slice(0, 4).map((l) => l[s])) : null, playedLast: p.playedLast };
}

// ---------- market + picks ----------
// events: [{id, start, home, away, homeName, awayName, bookmakers, injuries:{home:[...], away:[...]}, weather}]
export function findPropPicks({ sport, data, events, licensed, titles = {} }) {
  const specs = PROP_SPECS[sport];
  const ctx = { data };
  const picks = [];
  let lines = 0, modeled = 0;
  for (const ev of events) {
    const homeAbbr = data.names[ev.homeName], awayAbbr = data.names[ev.awayName];
    for (const [market, spec] of Object.entries(specs)) {
      // Gather each player's Over/Under prices by line across books.
      const byPlayer = new Map();
      for (const b of ev.bookmakers || []) {
        titles[b.key] ||= b.title;
        const m = b.markets?.find((x) => x.key === market);
        for (const o of m?.outcomes || []) {
          if (o.point == null || !o.description || (o.name !== 'Over' && o.name !== 'Under')) continue;
          const pl = byPlayer.get(o.description) || new Map(); byPlayer.set(o.description, pl);
          const ln = pl.get(o.point) || new Map(); pl.set(o.point, ln);
          const bk = ln.get(b.key) || {}; ln.set(b.key, bk); bk[o.name] = o.price;
        }
      }
      for (const [playerName, byLine] of byPlayer) {
        // The main line is the one most books offer.
        const [line, books] = [...byLine.entries()].sort((a, b) => b[1].size - a[1].size || Math.abs(a[0]) - Math.abs(b[0]))[0];
        const both = [...books.entries()].filter(([, v]) => v.Over && v.Under);
        if (both.length < 3) continue;
        lines++;
        const p = data.players[nameKey(playerName)];
        if (!p) continue;
        const isHome = p.team === homeAbbr, isAway = p.team === awayAbbr;
        if (!isHome && !isAway) continue; // traded or mismatched name: skip rather than guess
        const injuries = isHome ? ev.injuries?.home : ev.injuries?.away;
        const own = (injuries || []).find((i) => nameKey(i.player) === nameKey(playerName));
        if (own && OUT_RE.test(own.status)) continue;
        const game = { start: ev.start, opp: isHome ? awayAbbr : homeAbbr, oppName: isHome ? ev.awayName : ev.homeName, teamInjuries: injuries, weather: ev.weather };
        const proj = sport === 'basketball_nba' ? projectNba(ctx, p, spec, game) : projectNfl(ctx, p, spec, game);
        if (!proj || !(proj.mean > 0)) continue;
        if (sport === 'basketball_nba' && proj.minutes < 14) continue;
        modeled++;
        const pOver = clamp(overChance(line, proj.mean, proj.sd, spec.poisson, spec.skew), 0.02, 0.98);
        const fairOver = avg(both.map(([, v]) => { const a = 1 / v.Over, b = 1 / v.Under; return a / (a + b); }));
        const notes = [...proj.notes];
        let w = MODEL_WEIGHT;
        if (own && Q_RE.test(own.status)) { w = 0.2; notes.unshift({ t: `${own.status}${own.injury ? ` (${own.injury})` : ''}: check he's playing before you bet`, good: false, warn: true }); }
        if (!proj.fresh) { w = Math.min(w, 0.25); notes.push({ t: `Only ${proj.sample} game${proj.sample === 1 ? '' : 's'} this season: leaning on last season`, good: false }); }
        if (proj.playedLast === false) { w = Math.min(w, 0.2); notes.push({ t: "Didn't play his team's last game", good: false, warn: true }); }
        for (const side of ['Over', 'Under']) {
          const model = side === 'Over' ? pOver : 1 - pOver;
          const market0 = side === 'Over' ? fairOver : 1 - fairOver;
          const offers = Object.fromEntries([...books.entries()].filter(([k, v]) => licensed.has(k) && v[side]).map(([k, v]) => [k, v[side]]));
          const bestKey = Object.keys(offers).sort((a, b) => offers[b] - offers[a])[0];
          if (!bestKey) continue;
          const chance = w * model + (1 - w) * market0;
          const edge = chance * offers[bestKey] - 1;
          if (model <= market0 || edge < 0.01 || chance < 0.4) continue; // skip long-odds props (mostly alt lines / heavy juice)
          const hits = proj.last10.filter((v) => (side === 'Over' ? v > line : v < line)).length;
          const why = [
            { t: `Season avg ${r1(proj.seasonAvg ?? NaN)}${proj.l5Avg != null ? `, last ${sport === 'basketball_nba' ? 5 : 4} avg ${r1(proj.l5Avg)}` : ''}`, good: side === 'Over' ? (proj.l5Avg ?? proj.seasonAvg) > line : (proj.l5Avg ?? proj.seasonAvg) < line },
            { t: `${side === 'Over' ? 'Over' : 'Under'} ${line} in ${hits} of his last ${proj.last10.length}`, good: hits / Math.max(1, proj.last10.length) >= 0.6 },
            ...notes.map((x) => ({ ...x, good: x.warn ? false : side === 'Over' ? x.good : !x.good })),
          ];
          picks.push({
            eventId: ev.id, game: `${ev.awayName} @ ${ev.homeName}`, start: ev.start, player: p.name, team: p.team, pos: p.pos, opp: game.opp,
            market, stat: spec.label, short: spec.short, side, line, pick: `${p.name} ${side} ${line} ${spec.label}`,
            projection: r1(proj.mean), modelChance: model, marketChance: market0, chance, edge,
            best: { book: bestKey, title: titles[bestKey] || bestKey, price: offers[bestKey] }, offers, books: both.length,
            oddsName: playerName, home: ev.homeName, away: ev.awayName, prices: Object.fromEntries(both.filter(([k]) => licensed.has(k))),
            last10: proj.last10, why: why.filter((x) => !x.t.includes('NaN')), status: own?.status || null,
            confidence: edge >= 0.04 && model - market0 >= 0.08 && w >= MODEL_WEIGHT ? 'strong' : 'lean',
          });
        }
      }
    }
  }
  // Rank by value weighted by how likely the bet is to win (same rule as Edge Picks), not edge alone.
  const likely = (q) => Math.max(0, Math.min(1, (q - 0.2) / 0.4));
  for (const x of picks) x.score = x.edge * likely(x.chance);
  picks.sort((a, b) => b.score - a.score);
  // Spread them out: at most 2 per player and 4 per game.
  const perPlayer = {}, perGame = {}, top = [];
  for (const x of picks) {
    if ((perPlayer[x.player] || 0) >= 2 || (perGame[x.eventId] || 0) >= 4) continue;
    perPlayer[x.player] = (perPlayer[x.player] || 0) + 1; perGame[x.eventId] = (perGame[x.eventId] || 0) + 1;
    top.push(x);
  }
  return { picks: top, considered: lines, modeled, found: picks.length };
}
