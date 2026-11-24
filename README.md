[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vickyair1/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vickyair1/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Boothlord V10-loose — pump.fun paper bot

Paper-trading bot for the make.fun Boothlord pump.fun sprint (6-hour window,
10 SOL capital). It pyramids into early-momentum coins and exits on tight
rules — no partial exits, no trailing stops.

## Strategy

**Tracking.** Every coin is followed from its `CreateEvent`: creator, creator
buy total, distinct non-creator buyers, trade count, creator-sold flag.

**Entry (all must hold, coin age <= 6 slots).**

- Creator bought 0.15–2.5 SOL total
- Real quote reserve 3–50 SOL
- At least 4 trades, at least 5 distinct non-creator buyers
- Creator has not sold; coin not completed; under the 5-position cap

**Sizing.** Target stake 2 SOL per coin. Each reply inside the window buys
`min(remaining target, 1% of real reserve)`; minimum buy 0.005 SOL. No buys
after age 6.

**Exits (full position, every batch).**

- Take profit: liquidation value (net of the 1.25% curve fee and one tx fee)
  >= 120% of total spent
- Stop loss: liquidation value <= 85% of total spent
- Max hold: 300 slots since the first fill
- Creator sell while holding

Exited coins are never re-entered. Sells in flight are never duplicated; a
failed sell is retried on the next batch. Spent is tracked from fills only,
so a pending buy is never double-counted.

## Determinism

No clock, no randomness, no I/O; iteration is insertion-ordered only. Two
runs over the same data emit byte-identical orders.

## Run

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --worktree
```
