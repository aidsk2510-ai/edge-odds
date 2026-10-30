// Edge fantasy engine: rankings (points + 9-cat) and trade evaluation.
// Runs in the browser and on the server, so it has no dependencies.
(function () {
  const CATS = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];
  const CAT_LABEL = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', tov: 'TO' };
  const STAT_KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'reb', 'ast', 'stl', 'blk', 'tov', 'pts', 'pf', 'pm', 'gs', 'dd', 'td'];
  const SCORING = {
    espn: { label: 'ESPN default', pts: 1, tpm: 1, fga: -1, fgm: 2, fta: -1, ftm: 1, reb: 1, ast: 2, stl: 4, blk: 4, tov: -2, dd: 0, td: 0 },
    yahoo: { label: 'Yahoo default', pts: 1, tpm: 0, fga: 0, fgm: 0, fta: 0, ftm: 0, reb: 1.2, ast: 1.5, stl: 3, blk: 3, tov: -1, dd: 0, td: 0 },
  };
  const SCORE_KEYS = ['pts', 'tpm', 'fgm', 'fga', 'ftm', 'fta', 'reb', 'ast', 'stl', 'blk', 'tov', 'dd', 'td'];
  const SEASON_GAMES = 82;
  const PRIOR_GAMES = 12; // how many games of last season to blend into "Projected"

  // ---------- per-game lines ----------
  function perGame(t) {
    if (!t || !t.gp) return null;
    const g = { gp: t.gp };
    for (const k of STAT_KEYS) g[k] = (t[k] || 0) / t.gp;
    g.usg = t.useT > 0 ? (100 * t.useP) / t.useT : null;
    g.ts = t.fga + t.fta > 0 ? t.pts / (2 * (t.fga + 0.44 * t.fta)) : null;
    g.efg = t.fga > 0 ? (t.fgm + 0.5 * t.tpm) / t.fga : null;
    g.fgp = t.fga > 0 ? t.fgm / t.fga : null;
    g.ftp = t.fta > 0 ? t.ftm / t.fta : null;
    g.tpp = t.tpa > 0 ? t.tpm / t.tpa : null;
    g.astTo = t.tov > 0 ? t.ast / t.tov : null;
    g.startPct = t.gs / t.gp;
    return g;
  }

  // Projected = this season, filled in with up to PRIOR_GAMES of last season's per-game rate.
  // Early in the season this leans on last year; by mid-season it's almost all this year.
  function blend(cur, prev) {
    if (!cur?.gp && !prev?.gp) return null;
    if (!prev?.gp || prev.gp < 10) return cur?.gp ? cur : null;
    const w = PRIOR_GAMES / prev.gp;
    const out = { gp: (cur?.gp || 0) + PRIOR_GAMES };
    for (const k of [...STAT_KEYS, 'useP', 'useT']) out[k] = (cur?.[k] || 0) + (prev[k] || 0) * w;
    return out;
  }

  function line(p, mode) {
    if (mode === 'cur') return perGame(p.cur);
    if (mode === 'l14') return perGame(p.l14);
    if (mode === 'prev') return perGame(p.prev);
    return perGame(blend(p.cur, p.prev));
  }

  // ---------- points leagues ----------
  function fpts(g, s) {
    if (!g) return null;
    let v = 0;
    for (const k of SCORE_KEYS) v += (g[k] || 0) * (Number(s[k]) || 0);
    return v;
  }

  // ---------- 9-cat z-scores ----------
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = (a, m) => Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length || 1)) || 1;

  function zScores(rows, poolSize, punt) {
    // rows: [{g}] with per-game lines. Two passes: rough pool, then the real pool (top N by value).
    let pool = rows.slice().sort((a, b) => b.g.pts + b.g.reb + b.g.ast * 1.5 + (b.g.stl + b.g.blk) * 3 - (a.g.pts + a.g.reb + a.g.ast * 1.5 + (a.g.stl + a.g.blk) * 3)).slice(0, poolSize);
    let ref = null;
    for (let pass = 0; pass < 3; pass++) {
      const fgPct = pool.reduce((x, r) => x + r.g.fgm, 0) / (pool.reduce((x, r) => x + r.g.fga, 0) || 1);
      const ftPct = pool.reduce((x, r) => x + r.g.ftm, 0) / (pool.reduce((x, r) => x + r.g.fta, 0) || 1);
      // Percentages count by impact: how much a player moves your team's % (his % vs average, times his attempts).
      const raw = (g, c) => (c === 'fg' ? (g.fga ? (g.fgm / g.fga - fgPct) * g.fga : 0) : c === 'ft' ? (g.fta ? (g.ftm / g.fta - ftPct) * g.fta : 0) : g[c]);
      ref = { fgPct, ftPct, m: {}, s: {} };
      for (const c of CATS) { const v = pool.map((r) => raw(r.g, c)); ref.m[c] = mean(v); ref.s[c] = sd(v, ref.m[c]); }
      for (const r of rows) {
        r.z = {};
        for (const c of CATS) { const z = (raw(r.g, c) - ref.m[c]) / ref.s[c]; r.z[c] = c === 'tov' ? -z : z; }
        r.value = CATS.reduce((x, c) => x + (punt.has(c) ? 0 : r.z[c]), 0);
      }
      pool = rows.slice().sort((a, b) => b.value - a.value).slice(0, poolSize);
    }
    return ref;
  }

  // ---------- rankings ----------
  // opts: {format:'9cat'|'points', mode, scoring, punt:Set|Array, teams, roster, minGp}
  function rank(players, opts = {}) {
    const o = normalize(opts);
    const rows = [];
    for (const p of players) {
      const g = line(p, o.mode);
      if (!g || g.gp < o.minGp) continue;
      rows.push({ p, g });
    }
    const poolSize = o.teams * o.roster;
    if (o.format === 'points') {
      for (const r of rows) { r.fp = fpts(r.g, o.scoring); r.value = r.fp; }
    } else {
      zScores(rows, poolSize, o.punt);
    }
    rows.sort((a, b) => b.value - a.value);
    rows.forEach((r, i) => { r.rank = i + 1; });
    // Replacement level = the average player just outside the rostered pool (what's on waivers).
    const band = rows.slice(poolSize, poolSize + 10);
    const repl = { value: band.length ? mean(band.map((r) => r.value)) : 0, z: {} };
    for (const c of CATS) repl.z[c] = band.length && band[0].z ? mean(band.map((r) => r.z[c])) : 0;
    if (o.format === 'points') repl.fp = repl.value;
    return { rows, poolSize, repl, opts: o };
  }

  function normalize(opts) {
    const o = { format: '9cat', mode: 'proj', teams: 12, roster: 13, minGp: 1, scoring: SCORING.espn, ...opts };
    o.punt = new Set(o.punt || []);
    o.teams = Math.max(4, Math.min(20, Number(o.teams) || 12));
    o.roster = Math.max(5, Math.min(20, Number(o.roster) || 13));
    if (typeof o.scoring === 'string') o.scoring = SCORING[o.scoring] || SCORING.espn;
    return o;
  }

  // ---------- availability ----------
  const DAY = 86400e3;
  function availability(p, team, now = Date.now()) {
    const teamGp = team?.gp || 0;
    const left = Math.max(0, SEASON_GAMES - teamGp);
    // Durability: share of team games he played (this season + last season).
    const played = (p.cur?.gp || 0) + (p.prev?.gp || 0);
    const possible = teamGp + (p.prev?.gp ? SEASON_GAMES : 0);
    let durability = possible >= 10 ? Math.min(1, played / possible) : 0.9;
    durability = Math.max(0.55, durability);
    let missed = 0, why = null;
    const inj = p.inj;
    if (inj) {
      const s = String(inj.status || '');
      const back = inj.returns ? Date.parse(inj.returns) : NaN;
      if (/^out|^ir|injured reserve|suspension/i.test(s)) {
        if (Number.isFinite(back)) { missed = Math.max(0, Math.round(((back - now) / DAY) * (SEASON_GAMES / 174))); why = `out, expected back ${new Date(back).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; }
        else { missed = Math.min(left, 8); why = 'out, no return date (assumed ~8 games)'; }
      } else if (/^doubtful/i.test(s)) { missed = 1; why = 'doubtful'; }
      else if (/^questionable|^day-to-day/i.test(s)) { missed = 0.5; why = 'day-to-day'; }
    }
    missed = Math.min(left, missed);
    const games = Math.max(0, (left - missed) * durability);
    return { left, missed, durability, games, why };
  }

  // ---------- context: role, usage, depth ----------
  function context(p, players, mode) {
    const g = line(p, mode) || line(p, 'prev');
    const mates = players.filter((q) => q.team === p.team && (q.cur?.gp || 0) > 0);
    const byMin = mates.map((q) => ({ q, g: perGame(q.cur) })).filter((x) => x.g).sort((a, b) => b.g.min - a.g.min);
    const minRank = byMin.findIndex((x) => x.q.id === p.id) + 1 || null;
    const byUsg = byMin.filter((x) => x.g.min >= 12 && x.g.usg != null).sort((a, b) => b.g.usg - a.g.usg);
    const usgRank = byUsg.findIndex((x) => x.q.id === p.id) + 1 || null;
    const sameSpot = byMin.filter((x) => x.q.id !== p.id && posGroup(x.q.pos) === posGroup(p.pos)).slice(0, 4)
      .map((x) => ({ name: x.q.name, mpg: x.g.min, usg: x.g.usg, inj: x.q.inj?.status || null }));
    const matesOut = mates.filter((q) => q.id !== p.id && q.inj && /^out|^ir|injured reserve|suspension/i.test(q.inj.status || ''))
      .map((q) => ({ name: q.name, usg: perGame(q.cur)?.usg ?? perGame(q.prev)?.usg ?? null, mpg: perGame(q.cur)?.min ?? null }))
      .filter((x) => (x.mpg || 0) >= 15);
    const cur = perGame(p.cur), l14 = perGame(p.l14), prev = perGame(p.prev);
    const minTrend = cur && l14 && cur.gp >= 6 && l14.gp >= 3 ? l14.min - cur.min : cur && prev ? cur.min - prev.min : null;
    const usgTrend = cur && prev && cur.usg != null && prev.usg != null ? cur.usg - prev.usg : null;
    const role = !g ? 'unknown' : g.startPct >= 0.6 ? 'starter' : g.min >= 22 ? 'key bench' : g.min >= 14 ? 'rotation' : 'fringe';
    return { line: g, minRank, rotation: byMin.length, usgRank, role, sameSpot, matesOut, minTrend, usgTrend, minTrendBasis: cur && l14 && cur.gp >= 6 && l14.gp >= 3 ? 'last 14 days vs season' : 'this season vs last' };
  }
  const posGroup = (pos) => (/C/.test(pos || '') ? 'big' : /F/.test(pos || '') ? 'wing' : 'guard');

  // ---------- trade evaluation ----------
  // trade: {give:[ids], get:[ids]}. Returns a full breakdown.
  function evaluate(data, trade, opts = {}) {
    const R = rank(data.players, { ...opts, minGp: 1 });
    const o = R.opts;
    const byId = new Map(R.rows.map((r) => [r.p.id, r]));
    const pById = new Map(data.players.map((p) => [p.id, p]));
    const replPer = o.format === 'points' ? R.repl.fp : R.repl.value;
    const side = (ids) => ids.map((id) => {
      const p = pById.get(id);
      if (!p) return null;
      const r = byId.get(id);
      const per = r ? r.value : replPer; // no usable stats → treat as waiver-level
      const av = availability(p, data.teams?.[p.team]);
      const over = per - replPer;
      return {
        id, name: p.name, team: p.team, pos: p.pos, inj: p.inj || null, rank: r?.rank || null,
        per, perOverRepl: over, games: av.games, avail: av, rest: over * av.games, z: r?.z || null, fp: r?.fp ?? null,
        ctx: context(p, data.players, o.mode), sample: (p.cur?.gp || 0),
      };
    }).filter(Boolean);
    const give = side(trade.give || []), get = side(trade.get || []);
    // Roster spots: the side taking back more players has to cut someone (a waiver-level player, worth 0 over replacement),
    // and the side taking back fewer gets an open spot to fill from waivers (also 0). Using value over replacement handles both.
    const extra = get.length - give.length;
    const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
    const restIn = sum(get, (x) => x.rest), restOut = sum(give, (x) => x.rest);
    const perIn = sum(get, (x) => x.perOverRepl), perOut = sum(give, (x) => x.perOverRepl);
    // Categories: per-game change to your team, including the waiver player you add (or cut) to balance roster spots.
    let cats = null;
    if (o.format !== 'points') {
      cats = {};
      for (const c of CATS) {
        const zin = sum(get, (x) => x.z?.[c] ?? R.repl.z[c]);
        const zout = sum(give, (x) => x.z?.[c] ?? R.repl.z[c]);
        cats[c] = zin - zout - extra * R.repl.z[c];
      }
    }
    let fpChange = null;
    if (o.format === 'points') fpChange = { perGame: perIn - perOut, rest: restIn - restOut };
    const delta = restIn - restOut;
    const scale = Math.max(Math.abs(restIn), Math.abs(restOut), o.format === 'points' ? 150 : 10);
    const pct = delta / scale;
    const verdict = !give.length || !get.length ? 'incomplete' : pct > 0.12 ? 'win' : pct < -0.12 ? 'loss' : pct > 0.04 ? 'slight win' : pct < -0.04 ? 'slight loss' : 'fair';
    const flags = [];
    for (const [who, list] of [['You get', get], ['You give', give]]) for (const x of list) {
      if (x.avail.why) flags.push(`${who}: ${x.name} is ${x.avail.why}.`);
      if (x.sample > 0 && x.sample < 6 && o.mode !== 'prev') flags.push(`${who}: ${x.name} has only ${x.sample} games this season, so the numbers lean on last season.`);
      if (x.sample === 0 && o.mode === 'cur') flags.push(`${who}: ${x.name} hasn't played this season.`);
      if (x.ctx.minTrend != null && Math.abs(x.ctx.minTrend) >= 4) flags.push(`${who}: ${x.name}'s minutes are ${x.ctx.minTrend > 0 ? 'up' : 'down'} ${Math.abs(x.ctx.minTrend).toFixed(1)} per game (${x.ctx.minTrendBasis}).`);
      if (x.ctx.usgTrend != null && Math.abs(x.ctx.usgTrend) >= 3) flags.push(`${who}: ${x.name}'s usage is ${x.ctx.usgTrend > 0 ? 'up' : 'down'} ${Math.abs(x.ctx.usgTrend).toFixed(1)} points from last season.`);
      if (x.ctx.matesOut.length) flags.push(`${who}: ${x.name}'s teammate${x.ctx.matesOut.length > 1 ? 's' : ''} ${x.ctx.matesOut.map((m) => m.name).join(', ')} ${x.ctx.matesOut.length > 1 ? 'are' : 'is'} out, which can mean more shots and minutes for now.`);
    }
    if (extra < 0) flags.push(`You get ${-extra} open roster spot${extra < -1 ? 's' : ''} to fill from waivers; that's counted.`);
    if (extra > 0) flags.push(`You'll need to drop ${extra} player${extra > 1 ? 's' : ''} to make room; we assume a waiver-level player, so drop wisely.`);
    return { format: o.format, mode: o.mode, teams: o.teams, roster: o.roster, punt: [...o.punt], give, get, restIn, restOut, perIn, perOut, delta, pct, verdict, cats, fpChange, replPer, flags };
  }

  const api = { CATS, CAT_LABEL, SCORING, SCORE_KEYS, perGame, blend, line, fpts, rank, evaluate, availability, context, normalize };
  if (typeof globalThis !== 'undefined') globalThis.EdgeFantasy = api;
})();
