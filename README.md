# Edge — live odds board

Compares live and pre-game betting odds across major US sportsbooks (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Fanatics, BetRivers, Hard Rock, Bally Bet, Bovada and more) for NFL, NCAAF, NBA, NCAAB, WNBA, NHL, MLB, Premier League, Champions League, La Liga, MLS and UFC/MMA.

- Moneyline, spread and total markets
- The best price for each side is highlighted, with which book has it
- In-play games are marked **LIVE** and refresh every 30 seconds. Prices that moved flash green or red.
- **Best-line hold** for every game: the combined margin if you take the best price on each side. Below 0% means an arbitrage opportunity.
- American or decimal odds, team search, a live-only filter, and toggles to show or hide books (remembered per browser)
- With no API key, it runs on simulated data

## Run it locally

Requires Node 18+. There are no dependencies to install.

```bash
cp .env.example .env            # optional, for reference
ODDS_API_KEY=your_key npm start # → http://localhost:3000
```

Without `ODDS_API_KEY`, the site runs in demo mode with simulated odds.

## Getting odds data

Odds come from [The Odds API](https://the-odds-api.com). Sign up for a key there; a free tier is available for testing.

- **Credits:** each odds request costs credits based on *markets × regions*. The server caches each sport/market for `CACHE_SECONDS` (default 60s) and shares one upstream call across all visitors, so traffic doesn't multiply your usage. The sports list endpoint is free.
- **Books:** `ODDS_REGIONS=us,us2` covers the main US books. Caesars and Fanatics are only returned on paid plans. Add `uk`, `eu` or `au` for international books.
- **Budgeting:** with 3 markets × 12 sports × 2 regions, refreshing everything every 60s would use a lot of credits. In practice only the sport/market someone is viewing is fetched, and only once per cache window. If credits are tight, raise `CACHE_SECONDS`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ODDS_API_KEY` | — | The Odds API key (server-side only, never sent to browsers) |
| `ODDS_REGIONS` | `us,us2` | Bookmaker regions |
| `CACHE_SECONDS` | `60` | How long each upstream response is reused |
| `PORT` | `3000` | HTTP port |

To change the list of sports, edit `MAJOR_SPORTS` in `server.js` and `SPORTS` in `public/index.html`.

## Deploy

It's a single long-running Node process, so it works on any Node host: Render, Railway, Fly.io, DigitalOcean App Platform or a VPS.

1. Push this folder to a GitHub repo.
2. Create a web service. Build command: none. Start command: `npm start`.
3. Set `ODDS_API_KEY` in the host's environment settings.

## Structure

```
server.js          API proxy + cache + static file server
public/index.html  The whole front end (HTML/CSS/JS, no build step)
```

API routes: `GET /api/health`, `GET /api/sports`, `GET /api/odds?sport=<key>&market=h2h|spreads|totals`

## Before going public

- **Affiliate links / ads from sportsbooks:** most US states require affiliates to register or be licensed with the state gaming regulator. Check before adding referral links.
- Keep the 21+ and problem-gambling messaging in the footer. Some states require specific wording.
- Check The Odds API terms for commercial display of their data, and which plan covers it.

## Ideas for next steps

- Player props (`/v4/sports/{sport}/events/{id}/odds` with prop markets)
- Line-movement charts (store snapshots in SQLite/Postgres on each refresh)
- Deep links to each book's bet slip (`includeLinks=true` on the odds request)
- Live scores next to in-play games (`/v4/sports/{sport}/scores`)
- Push live updates over Server-Sent Events instead of polling
