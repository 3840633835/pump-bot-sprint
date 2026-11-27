// Dip-catcher: a mean-reversion bot for the pump.fun bonding-curve replay.
//
// The idea is the opposite of chasing momentum. On pump.fun most curves spike on launch,
// get dumped by the first sellers, and then either die or bounce as new buyers step in at
// the lower price. This bot only buys the bounce, never the spike:
//
//   1. Wait for a real sell-off: the price falls at least dipPct below its recent high and
//      net SOL flow over the last flowWindow slots is clearly negative (sellers drove it down).
//   2. Wait for buyers to come back: net flow over the last returnWindow slots is positive
//      with at least two buy trades, and no single large sell just landed. A dip with no
//      returning buyers is a falling knife, not a bounce, and is skipped.
//   3. Buy once, small and fixed (stakeSol). No pyramiding: a dip that keeps dipping is
//      exited, not averaged down.
//   4. Sell the whole position on the first of: take-profit at the bounce target, stop loss,
//      a trailing stop once the bounce is real, a stall exit when the bounce never comes and
//      flow turns negative again, or a time limit.
//
// That is deliberately different from a momentum bot (which buys strength and pyramids into
// it) and from a "buy every survivor" bot (which buys a reserve band and holds). The edge
// here is selection: most dips are skipped, and the ones taken have already shown buyers
// returning before any money is risked.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of tape kept for the recent high. */
  highWindow: number;
  /** Price must have fallen at least this far below the recent high. */
  dipPct: number;
  /** Slots over which the sell-off flow is measured. */
  flowWindow: number;
  /** Net SOL over flowWindow must be at most this (negative: sellers drove the dip). */
  maxDipNetSol: number;
  /** Slots over which returning buy flow is measured. */
  returnWindow: number;
  /** Net SOL over returnWindow must be at least this (buyers are back). */
  minReturnNetSol: number;
  /** Buy trades in returnWindow needed to confirm buyers are back. */
  minReturnBuys: number;
  /** Distinct buyers over flowWindow needed (not one wallet washing). */
  minBuyers: number;
  /** Distinct sellers over flowWindow must be at most this (a whale dump, not a broad exit). */
  maxSellers: number;
  /** Price must already have recovered at least this far off the recent low (a V, not a flat bottom). */
  recoveryPct: number;
  /** Slots over which the trend is measured (pullback inside an uptrend, not a downtrend dip). */
  trendWindow: number;
  /** Price must be at least this far above where it was trendWindow slots ago. */
  minTrend: number;
  /** A single sell of at least this many SOL in returnWindow vetoes the entry. */
  bigSellSol: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL in the single buy of one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  takeProfit: number;
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Stall exit: after stallSlots held, exit when value is below cost * (1 + stallUp) and flow is negative. */
  stallSlots: number;
  stallUp: number;
  stallWindow: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// The settings main.ts trades with. Chosen on the dev window with tools/sweep.ts,
// preferring flat regions of the grid over its single best cell: minAge 200-400,
// minRqSol 2-12 and dipPct 0.08-0.12 all land within -0.11 to -0.29 SOL, and this
// cell is the best of the broad (>= 80-coin) region. The dev window is uniformly
// adverse for every entry rule tried (momentum pilot -9.39 SOL, hot-launch -0.38,
// completion-ride -0.91, dip variants -0.05 to -0.64), so the pick optimises for
// a small drawdown, many coins (breadth the final 6-8h window needs for the
// 20-coin guardrail), and a payoff skew where wins run to +100% while losses are
// capped near -5%: on the final window one or two runners flip the net positive.
export const DEFAULT_PARAMS: Params = {
  highWindow: 240,
  dipPct: 0.1,
  flowWindow: 60,
  maxDipNetSol: -0.5,
  returnWindow: 20,
  minReturnNetSol: 0,
  minReturnBuys: 2,
  minBuyers: 3,
  maxSellers: 999,
  recoveryPct: 0,
  trendWindow: 1000,
  minTrend: 0,
  bigSellSol: 2,
  minRqSol: 5,
  maxRqSol: 80,
  minAge: 300,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.2,
  stopLoss: 0.05,
  trail: 0.25,
  trailArm: 0.08,
  stallSlots: 240,
  stallUp: 0.02,
  stallWindow: 20,
  maxHold: 1800,
  cooldown: 150,
  maxEntries: 2,
  maxOpen: 5,
  maxExposureSol: 4,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.highWindow, p.flowWindow, p.trendWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, plus buy count, buyers, sellers. */
  const flowStats = (t: Tape, now: number, w: number): { net: number; buys: number; buyers: Set<string>; sellers: Set<string>; bigSell: boolean } => {
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    let bigSell = false;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
      } else {
        sellers.add(tr.user);
        if (tr.sol >= p.bigSellSol) bigSell = true;
      }
    }
    return { net, buys, buyers, sellers, bigSell };
  };

  /** Highest and lowest recorded price over the last `w` slots, and the latest price. */
  const highLow = (t: Tape, now: number, w: number): { high: number; low: number; last: number; n: number } => {
    let high = 0;
    let low = Infinity;
    let last = 0;
    let n = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      last = tr.price;
      n++;
    }
    return { high, low, last, n };
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) return false;
    const { high, low, n } = highLow(t, now, p.highWindow);
    if (n < 3 || high <= 0 || low === Infinity) return false;
    // The dip: price at least dipPct below the recent high.
    if (price > high * (1 - p.dipPct)) return false;
    // The bounce has started: price already recovered off the low.
    if (price < low * (1 + p.recoveryPct)) return false;
    // The trend: a pullback inside an uptrend, not a dip inside a downtrend.
    if (p.minTrend > 0) {
      let old = 0;
      for (const tr of t.trades) {
        if (tr.slot <= now - p.trendWindow) old = tr.price;
        else break;
      }
      if (old <= 0 || price < old * (1 + p.minTrend)) return false;
    }
    // The sell-off: sellers drove the dip, and it was few sellers, not a broad exit.
    const dip = flowStats(t, now, p.flowWindow);
    if (dip.net > p.maxDipNetSol) return false;
    if (dip.buyers.size < p.minBuyers) return false;
    if (dip.sellers.size > p.maxSellers) return false;
    // Buyers are back: recent flow positive, at least two buys, no fresh whale dump.
    const ret = flowStats(t, now, p.returnWindow);
    if (ret.net <= p.minReturnNetSol || ret.buys < p.minReturnBuys) return false;
    if (ret.bigSell) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.stallSlots && value < cost * (1 + p.stallUp)) {
          if (flowStats(t, now, p.stallWindow).net < 0) exit = true;
        }
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries: one fixed-size buy per dip, never averaged down.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = p.maxOpen - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint)) continue;
        if (slotsLeft <= 0) break;
        const t = tapes.get(mint)!;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }
      return orders;
    },
  };
}
