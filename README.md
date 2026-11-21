# Tank Turn Tactics

Room-based, multi-day Tank Turn Tactics. Players join a room with a 5-letter code. State is saved to `data/rooms.json`
so games survive restarts and can run for weeks.

## Run locally
```
npm install
npm start      # http://localhost:3000
```
Choose **Fast test** pace when creating a room to get AP every few minutes while testing.

## Put it on the internet
1. Push this folder to GitHub.
2. Deploy on Render / Railway / Fly.io as a Node web service (build: `npm install`, start: `npm start`).
3. **Attach a persistent disk/volume** and set `DATA_DIR` to its mount path (e.g. `/data`),
   otherwise free hosts wipe `data/` on redeploy and your long-running games vanish.
   Free tiers that sleep will also delay AP/heart ticks until the server wakes up (they're processed on wake).

## Rules implemented
3 hearts / 0 AP / range 2 · 1 AP each workday (random time, UTC weekdays) · move (1, 8 directions), shoot (1), upgrade range (1 AP, then 2, 3, ... rising each time; no buying hearts)
· kill steals AP · dead stay on board, vote daily to haunt someone (no AP that day) · gifting a heart to the dead revives them (1 heart, 0 AP)
· daily random heart spawn · AP is secret · when 4 remain, survivors submit a ranking; game ends when all match (or 1 left) · First Blood tracked.

There is no prize money: finishing a game earns **points** on your account (see below).

## Bot & accelerated matches
- **Accelerated:** choose it when creating a room and set minutes-between-AP. 10 min is roughly a 2 hour match
  (AP, heart spawns and jury haunting all follow that clock; weekends are not skipped).
- **Bot match:** solo vs 1-12 bots with instant start. In any lobby the host can also press "+ Add bot".
  Bots shoot, chase hearts and enemies, upgrade range, vote on the jury and agree to a human's proposed placings.

## Accounts, points & shop
- Players register/log in (username + password, hashed with scrypt). Accounts live in `data/accounts.json` next to `rooms.json`,
  so keep `DATA_DIR` on a persistent disk. Your account lists your active games, so you can resume on any device.
- Points when a game ends: 1st 60 · 2nd 40 · 3rd 30 · 4th 20 · everyone else 10 · First Blood +10 · +3 per kill.
  Bots earn nothing, but bot matches pay full points, so they can be farmed. Tune `PTS`, `PARTICIPATION`, `FIRST_BLOOD` and `PER_KILL` in `server.js`.
- Spend points in the Shop on **icons** (replace your letter on the board) and **titles** (shown before your name).
  Edit the `CATALOG` object in `server.js` to add items or change prices.
- Note: there's no email/password reset or rate limiting yet, and points are easy to farm via bot matches or by friends trading wins.
