// Edge Picks engine — pure math, no AI. Shared by the server (live data) and the page (demo mode).
// For each game and bet type it:
//   1. works out each side's fair chance from ALL books (removing each book's built-in margin, then averaging),
//   2. finds the best price at a licensed US book and how it compares with that fair chance ("edge"),
//   3. builds 2- and 3-leg parlays where every leg is at the SAME book (parlays can't mix books),
//      using one leg per game (legs from the same game are related, so the simple math wouldn't hold).
(function (root) {
  const LICENSED = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'fanatics', 'betrivers', 'espnbet', 'hardrockbet', 'ballybet', 'betparx', 'fliff'];
  const MIN_BOOKS = 3; // need at least this many books on the same line to trust the fair chance

  const toAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
  const fmtAmerican = (d) => { const a = toAmerican(d); return a > 0 ? `+${a}` : `${a}`; };

  // One "line" = one bet type at one number, e.g. spreads with home -3.5, or totals at 224.5.
  function linesFor(ev, mkt) {
    const groups = new Map();
    for (const b of ev.bookmakers || []) {
      const m = (b.markets || []).find((x) => x.key === mkt);
      if (!m || !m.outcomes || m.outcomes.length < 2) continue;
      let key = 'ml';
      if (mkt === 'spreads') key = String(m.outcomes.find((o) => o.name === ev.home_team)?.point ?? '');
      if (mkt === 'totals') key = String(m.outcomes[0].point ?? '');
      if (key === '') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ book: b.key, title: b.title, outcomes: m.outcomes });
    }
    return groups;
  }

  function analyze(events, opts = {}) {
    const now = opts.now ?? Date.now();
    const horizon = opts.horizonHours ?? 36;
    const books = new Set(opts.licensed || LICENSED);
    if (opts.includeOffshore) for (const e of events) for (const b of e.bookmakers || []) books.add(b.key);
    const markets = opts.markets || ['h2h', 'spreads', 'totals'];
    const sides = [];

    for (const ev of events) {
      const start = new Date(ev.commence_time).getTime();
      if (start <= now || start - now > horizon * 3600e3) continue; // upcoming games only (live odds move too fast)
      const game = `${ev.away_team} @ ${ev.home_team}`;
      for (const mkt of markets) {
        for (const [line, offers] of linesFor(ev, mkt)) {
          if (offers.length < MIN_BOOKS) continue;
          const names = offers[0].outcomes.map((o) => o.name);
          const complete = offers.filter((o) => names.every((n) => o.outcomes.some((x) => x.name === n && x.price > 1)));
          if (complete.length < MIN_BOOKS) continue;
          // Fair chance: remove each book's margin, then average across books
          const fair = Object.fromEntries(names.map((n) => [n, 0]));
          for (const o of complete) {
            const inv = names.map((n) => 1 / o.outcomes.find((x) => x.name === n).price);
            const s = inv.reduce((a, b) => a + b, 0);
            names.forEach((n, i) => { fair[n] += inv[i] / s / complete.length; });
          }
          for (const n of names) {
            const offersAtBooks = complete
              .filter((o) => books.has(o.book))
              .map((o) => { const x = o.outcomes.find((y) => y.name === n); return { book: o.book, title: o.title, price: x.price, point: x.point ?? null }; });
            if (!offersAtBooks.length) continue;
            const best = offersAtBooks.reduce((a, b) => (b.price > a.price ? b : a));
            const label = mkt === 'h2h' ? `${n} to win`
              : mkt === 'spreads' ? `${n} ${best.point > 0 ? '+' : ''}${best.point}`
              : `${n} ${best.point}`;
            sides.push({
              eventId: ev.id, game, start: ev.commence_time, market: mkt, line, pick: label, team: n,
              fair: fair[n], fairOdds: fmtAmerican(1 / fair[n]), best, bestOdds: fmtAmerican(best.price),
              edge: fair[n] * best.price - 1, books: complete.length,
              offers: Object.fromEntries(offersAtBooks.map((o) => [o.book, o.price])),
            });
          }
        }
      }
    }

    sides.sort((a, b) => b.edge - a.edge);
    const singles = sides.slice(0, opts.maxSingles ?? 8);

    // Parlay candidates: best side per game, top by edge
    const perGame = new Map();
    for (const s of sides) if (!perGame.has(s.eventId)) perGame.set(s.eventId, s);
    const pool = [...sides].filter((s) => s.edge > -0.05).slice(0, 24);
    const parlays = [];
    const combos = (arr, k, start = 0, acc = [], out = []) => {
      if (acc.length === k) { out.push(acc.slice()); return out; }
      for (let i = start; i < arr.length; i++) {
        if (acc.some((x) => x.eventId === arr[i].eventId)) continue; // one leg per game
        acc.push(arr[i]); combos(arr, k, i + 1, acc, out); acc.pop();
      }
      return out;
    };
    for (const k of [2, 3]) {
      for (const legs of combos(pool, k)) {
        for (const book of books) {
          if (!legs.every((l) => l.offers[book])) continue;
          const dec = legs.reduce((p, l) => p * l.offers[book], 1);
          const hit = legs.reduce((p, l) => p * l.fair, 1);
          const title = legs[0].best.book === book ? legs[0].best.title : (sides.find((s) => s.best.book === book)?.best.title || book);
          parlays.push({ legs: legs.map((l) => ({ pick: l.pick, game: l.game, market: l.market, odds: fmtAmerican(l.offers[book]), fair: l.fair })), book, title, dec, odds: fmtAmerican(dec), hit, ev: hit * dec - 1 });
        }
      }
    }
    // Best book for each set of legs, then rank by expected value
    const bestByLegs = new Map();
    for (const p of parlays) {
      const key = p.legs.map((l) => l.pick).join('|');
      if (!bestByLegs.has(key) || bestByLegs.get(key).dec < p.dec) bestByLegs.set(key, p);
    }
    const topParlays = [...bestByLegs.values()].sort((a, b) => b.ev - a.ev).slice(0, opts.maxParlays ?? 5);

    return { singles, parlays: topParlays, games: perGame.size, generatedAt: new Date(now).toISOString() };
  }

  // Plain-English write-up without AI (used in demo mode or if the AI is off).
  function plainSummary(r) {
    if (!r.singles.length) return 'No upcoming games with enough sportsbooks posting prices yet. Check back closer to game time.';
    const s = r.singles[0], p = r.parlays[0];
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    const lines = [];
    lines.push(s.edge >= 0
      ? `Best value: ${s.pick} at ${s.best.title} (${s.bestOdds}). It pays a little more than its real chance of winning (${pct(s.fair)}).`
      : `No bet is a true bargain right now. The closest to fair is ${s.pick} at ${s.best.title} (${s.bestOdds}), with about a ${pct(s.fair)} chance to win.`);
    if (p) lines.push(`Best parlay: ${p.legs.map((l) => l.pick).join(' + ')} at ${p.title} (${p.odds}). A $10 bet returns $${(10 * p.dec).toFixed(2)} and hits about ${pct(p.hit)} of the time.`);
    lines.push('Prices move. Check them at the sportsbook before betting.');
    return lines.join(' ');
  }

  root.EdgePicks = { analyze, plainSummary, LICENSED, fmtAmerican };
})(typeof globalThis !== 'undefined' ? globalThis : window);
