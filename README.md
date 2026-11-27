# Dip-catcher — Pump.fun Bot Sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed&ref=brisk-lark-63-4025)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/3840633835/pump-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed&ref=brisk-lark-63-4025)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/3840633835/pump-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed&ref=brisk-lark-63-4025)

A paper-trading bot for the 6h pump.fun replay (`agent-fun/replay/v2`). It buys the
bounce after a sell-off — never the spike.

## Idea

Most bonding curves spike on launch, get dumped by the first sellers, and then either
die or bounce as new buyers step in at the lower price. This bot only buys the bounce:

1. **Dip** — price fell at least 10% below its 240-slot high, driven by net selling.
2. **Buyers are back** — recent flow turned positive with at least two buys and no fresh
   whale dump. A dip with no returning buyers is a falling knife and is skipped.
3. **Buy once, small** — 0.05 SOL per position, no pyramiding, no averaging down.
4. **Sell the bounce** — take-profit, stop-loss, a trailing stop once the bounce is
   real, a stall exit when the bounce never comes, and a time limit.

See [METHODOLOGY.md](METHODOLOGY.md) for the full rule set and the honest backtest
numbers (wins, losses, net SOL, drawdown, determinism).

## Run it

The kit's harness runs the bot:

```bash
node /bot/main.ts
```

It reads batches of replay events on stdin and prints orders on stdout. The strategy
is in `strategy.ts`; `vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for
byte. `tools/` (in the kit, not here) provides the local simulator used for the
backtest in METHODOLOGY.md.

## Determinism

The bot never reads the clock, the environment, or `Math.random`; it only reacts to
the batch stream, in insertion order. Running the local simulator twice on the dev
window produces byte-identical action logs — see `test_determinism.sh`.

## License

MIT — see [LICENSE](LICENSE).
