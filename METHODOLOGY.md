# METHODOLOGY — Dip-catcher (Pump.fun Bot Sprint)

## The strategy

A mean-reversion bot: it buys the bounce after a sell-off, never the spike. Most
bonding curves spike on launch, get dumped by the first sellers, and then either
die or bounce as new buyers step in at the lower price. This bot only buys the
bounce, in four steps:

1. **Dip** — the price fell at least 10% below its 240-slot high, and net SOL flow
   over the last 60 slots is at most −0.5 SOL, i.e. sellers drove the dip down.
2. **Buyers are back** — net flow over the last 20 slots is positive with at least
   two buy trades from at least three distinct buyers in the window, and no single
   sell of ≥ 2 SOL just landed. A dip with no returning buyers is a falling knife
   and is skipped.
3. **Buy once, small and fixed** — 0.05 SOL per position, one buy per position, no
   pyramiding and no averaging down. At most 5 positions open, at most 4 SOL at
   cost across them. Entry only on curves 300+ slots old with 5–80 SOL of real
   reserve (old enough to have holders, liquid enough to exit, not about to
   complete).
4. **Sell the bounce** — the whole position goes on the first of: take-profit
   +20%, stop-loss −5%, a trailing stop of 25% once the position is +8% up, a
   stall exit (held 240+ slots, still under +2%, flow negative again), or a
   1800-slot time limit. A curve may be bought at most twice, with a 150-slot
   cooldown after an exit.

## Why this is not a momentum chase

A momentum bot buys strength and pyramids into it — the kit's own pilot does
exactly that and loses **−9.39 SOL** on the dev window (drawdown 95%, 5 wins in
80 trips). Buying strength on pump.fun mostly buys the top: the spike is the
exit of the early holders. The dip-catcher does the opposite: it waits for the
sellers to finish, demands proof buyers returned, and risks the same small
amount every time. Losses are capped near −5% plus fees; wins are uncapped
until the trailing stop — the best dev win is **+0.068 SOL on a 0.05 SOL stake
(+136%)**.

## What was tried and rejected (honest record)

Every entry rule was backtested on the kit's dev window (24h, Nov 2–3 2026,
1,222 coins, 35 completions) with the kit's local engine port. The window is
adverse for everything:

| Approach | Net PnL | Coins | Trips | Wins | Max DD |
|---|---|---|---|---|---|
| Kit pilot momentum (pyramid into strength) | **−9.387 SOL** | 48 | 80 | 5 | 95.0% |
| Hot-launch snipe (buy explosive early flow) | −0.379 SOL | 268 | 318 | 79 | 4.5% |
| Completion ride (buy 70–84 SOL reserve) | −0.914 SOL | 5 | 5 | 0 | 9.2% |
| Dip-catcher, loose (no filters) | −0.333 SOL | 133 | 197 | 20 | 4.5% |
| Dip-catcher, strict (few sellers + recovery) | −0.082 SOL | 20 | 24 | 2 | 1.0% |
| Dip-catcher, trend-filtered (uptrend pullback) | −0.053 SOL | 11 | 18 | 2 | 0.7% |
| **Dip-catcher, chosen** | **−0.128 SOL** | **81** | **131** | **17** | **3.1%** |

The strict and trend-filtered variants look better on net but trade too few
coins: the final window is only ~7.7h, so a 20-coin dev run is ~6 coins on the
final window and would miss the 20-coin guardrail entirely, and an 11-coin run
even more so. The chosen cell is the best of the broad (≥ 80-coin) region and
sits on a flat part of the sweep — minAge 200–400, minRqSol 2–12, dipPct
0.08–0.12 all land within −0.11 to −0.29 SOL — so it is not a knife-edge
optimum fitted to one cell. Expected final-window breadth is ~26 coins.

## Backtest (kit's local engine port, dev window, chosen settings)

| Run | Net PnL | Fills | Coins | Trips | Wins | Max DD |
|---|---|---|---|---|---|---|
| Full 24h dev | **−0.128 SOL** | 261 | 81 | 131 | 17 (13%) | 3.1% |
| Without failed txs | −0.125 SOL | — | — | — | — | — |
| At 2× fees | −0.249 SOL | — | — | — | — | — |
| Mean over 4 fail keys | −0.118 SOL | — | — | — | — | — |

Win sum +0.440 SOL, loss sum −0.568 SOL; average win +0.0259 SOL, average
loss −0.0050 SOL (a ~5:1 payoff skew); best win +0.068 SOL, worst loss
−0.043 SOL. Rejected orders: 0. The edge, if the final window has it, is the
skew: 17 wins at up to +136% against losses capped near −5%. The dev net is
negative, stated plainly — the final window is fresh data collected after
entries close, so no dev number guarantees a final result, and a prize needs
net PnL above 0 SOL after every fee. What the dev numbers do show is that
this bot cannot blow up the way the momentum pilot does (3.1% max drawdown
against the 50% guardrail) and that it keeps trading breadth through the whole
window.

## Determinism

No clock, no randomness, no network: the only inputs are the hello seed and
the batch stream, and all state lives in insertion-ordered maps. Two runs
through the kit's local engine on the dev window produce a byte-identical
action digest (sha256 `b4aa17be8d3f58df…`, net −0.128399984 SOL both times,
131 trips). `tests/test_determinism.sh` repeats the wire-level check: the same
hello + batches + done into `main.ts` twice, byte-identical replies out.
`grade-local` runs the bot twice in the harness and compares the action logs
as well.

## Files

- `main.ts` — entrypoint: `runBot(createStrategy(DEFAULT_PARAMS))`.
- `strategy.ts` — the strategy (entry, sizing, exits, risk controls).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte
  (sha256 `4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08`).
- `tests/test_determinism.sh` — wire-level determinism check.
