import {
  runBot,
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// V10-loose: pyramid into early momentum coins, tight exits.
// Entry window 6 slots; target 2 SOL per coin; TP +20% / SL -15% / 300 slots /
// creator-sell exits. Full-position sells only, no partials, no trailing stops.

interface Params {
  targetStakeLamports: bigint;
  minBuyLamports: bigint;
  entryWindowSlots: number;
  minCreatorBuyLamports: bigint;
  maxCreatorBuyLamports: bigint;
  minRealReserveLamports: bigint;
  maxRealReserveLamports: bigint;
  minTrades: number;
  minDistinctBuyers: number;
  takeProfitBps: bigint;
  stopLossBps: bigint;
  maxHoldSlots: number;
  maxSlippageBps: number;
}

interface CoinTrack {
  createSlot: number;
  creator: Pubkey;
  creatorBoughtLamports: bigint;
  buyers: Set<Pubkey>;
  trades: number;
  creatorSold: boolean;
  completed: boolean;
  finished: boolean;
}

interface PositionBook {
  firstFillSlot: number;
  spentLamports: bigint;
}

function toLamports(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return BigInt(v);
  return BigInt(Math.trunc(v));
}

// Net SOL received selling T tokens against curve (vt, vq):
// gross = T * vq / (vt + T), minus the 1.25% curve fee (rounded up),
// minus one tx fee for the sell. Floored at zero.
// All inputs are coerced: the driver delivers reserves/amounts as JSON
// numbers, not bigints, and mixing the two types throws.
function liquidationNet(
  tokenAmount: bigint,
  vt: bigint,
  vq: bigint,
  txFee: bigint,
): bigint {
  const t = toLamports(tokenAmount);
  const vtt = toLamports(vt);
  const vqq = toLamports(vq);
  const feeLamports = toLamports(txFee);
  if (t <= 0n) return 0n;
  const gross = (t * vqq) / (vtt + t);
  const fee = (gross * 125n + 9999n) / 10000n;
  const net = gross - fee - feeLamports;
  return net > 0n ? net : 0n;
}

export function createStrategy(p: Params) {
  const coins = new Map<string, CoinTrack>();
  const books = new Map<string, PositionBook>();

  function trackEvent(ev: any, state: BotState): void {
    if (ev.event === 'CreateEvent') {
      if (!coins.has(ev.mint)) {
        coins.set(ev.mint, {
          createSlot: ev.slot,
          creator: ev.creator,
          creatorBoughtLamports: 0n,
          buyers: new Set<Pubkey>(),
          trades: 0,
          creatorSold: false,
          completed: false,
          finished: false,
        });
      }
      return;
    }
    if (ev.event === 'TradeEvent') {
      let t = coins.get(ev.mint);
      if (!t) {
        const curve = state.curves.get(ev.mint);
        t = {
          createSlot: curve ? curve.created_slot : ev.slot,
          creator: '',
          creatorBoughtLamports: 0n,
          buyers: new Set<Pubkey>(),
          trades: 0,
          creatorSold: false,
          completed: false,
          finished: false,
        };
        coins.set(ev.mint, t);
      }
      t.trades += 1;
      if (ev.is_buy) {
        if (t.creator !== '' && ev.user === t.creator) {
          t.creatorBoughtLamports += toLamports(ev.sol_amount);
        } else {
          t.buyers.add(ev.user);
        }
      } else if (t.creator !== '' && ev.user === t.creator) {
        t.creatorSold = true;
      }
      return;
    }
    if (ev.event === 'CompleteEvent') {
      const t = coins.get(ev.mint);
      if (t) {
        t.completed = true;
        t.finished = true;
      }
      return;
    }
  }

  // ---- position/fill bookkeeping ----
  // Spent is updated ONLY from fills: a pending buy is never added to spent,
  // so it is counted exactly once (when its fill arrives), never twice.
  function applyFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // completion auto-close: the harness closed the position for us.
        books.delete(f.mint);
        continue;
      }
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const cost =
          toLamports(f.quote_lamports) + toLamports(f.tx_fee_lamports);
        const b = books.get(f.mint);
        if (b) {
          b.spentLamports += cost;
        } else {
          books.set(f.mint, { firstFillSlot: f.slot, spentLamports: cost });
        }
      } else if (f.side === 'sell') {
        books.delete(f.mint);
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: string): boolean {
    for (const [, pend] of state.pending) {
      if (pend.order.side === 'buy' && pend.order.mint === mint) return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: string): boolean {
    for (const [, pend] of state.pending) {
      if (pend.order.side === 'sell' && pend.order.mint === mint) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const txFee = toLamports(state.txFeeLamports());

      applyFills(state, batch);

      for (const ev of batch.events) trackEvent(ev, state);

      // ---- exits: check every open position every batch ----
      const marks = new Map<string, { vt: bigint; vq: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vt: m.virtual_token_reserves,
          vq: m.virtual_quote_reserves,
        });
      }
      for (const [mint, pos] of state.positions) {
        const tokenAmount = toLamports(pos.token_amount);
        if (tokenAmount <= 0n) continue;
        if (hasPendingSell(state, mint)) continue;
        let book = books.get(mint);
        if (!book) {
          book = {
            firstFillSlot: state.slot,
            spentLamports: toLamports(pos.cost_lamports) + txFee,
          };
          books.set(mint, book);
        }
        const mark = marks.get(mint);
        const curve = state.curves.get(mint);
        const vt = mark
          ? mark.vt
          : curve
            ? curve.virtual_token_reserves
            : 0n;
        const vq = mark
          ? mark.vq
          : curve
            ? curve.virtual_quote_reserves
            : 0n;
        if (vt <= 0n || vq <= 0n) continue;
        const liq = liquidationNet(tokenAmount, vt, vq, txFee);
        const spent = book.spentLamports;
        const track = coins.get(mint);
        const takeProfit = liq * BPS >= spent * p.takeProfitBps;
        const stopLoss = liq * BPS <= spent * p.stopLossBps;
        const maxHold = state.slot - book.firstFillSlot >= p.maxHoldSlots;
        const creatorSold = track ? track.creatorSold : false;
        if (takeProfit || stopLoss || maxHold || creatorSold) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: tokenAmount,
            max_slippage_bps: p.maxSlippageBps,
          });
          if (track) track.finished = true;
        }
      }

      // ---- entries: pyramid inside the 6-slot window ----
      let newPositions = 0;
      let cashUsed = 0n;
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const maxPositions = state.hello.caps.max_open_positions;
      for (const [mint, t] of coins) {
        if (orders.length >= maxOrders) break;
        if (t.completed || t.finished) continue;
        const age = state.slot - t.createSlot;
        if (age < 0 || age > p.entryWindowSlots) continue;
        if (t.creatorBoughtLamports < p.minCreatorBuyLamports) continue;
        if (t.creatorBoughtLamports > p.maxCreatorBuyLamports) continue;
        if (t.trades < p.minTrades) continue;
        if (t.buyers.size < p.minDistinctBuyers) continue;
        if (t.creatorSold) continue;
        const curve = state.curves.get(mint);
        if (!curve) continue;
        const reserve = toLamports(curve.real_quote_reserves);
        if (reserve < p.minRealReserveLamports) continue;
        if (reserve > p.maxRealReserveLamports) continue;
        const book = books.get(mint);
        const spent = book ? book.spentLamports : 0n;
        if (spent >= p.targetStakeLamports) continue;
        const alreadyCommitted =
          state.positions.has(mint) || hasPendingBuy(state, mint);
        if (
          !alreadyCommitted &&
          state.committedPositionCount() + newPositions >= maxPositions
        ) {
          continue;
        }
        const remaining = p.targetStakeLamports - spent;
        const cap = toLamports(state.maxBuyLamports(mint));
        const amount = remaining < cap ? remaining : cap;
        if (amount < p.minBuyLamports) continue;
        if (amount + txFee > toLamports(state.freeCashLamports()) - cashUsed) {
          continue;
        }
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: p.maxSlippageBps,
        });
        cashUsed += amount + txFee;
        if (!alreadyCommitted) newPositions += 1;
      }

      return orders;
    },
  };
}

// --- final wiring: V10-loose param defaults + bot start ---
const DEFAULT_PARAMS: Params = {
  targetStakeLamports: 2n * LAMPORTS_PER_SOL,
  minBuyLamports: (5n * LAMPORTS_PER_SOL) / 1000n, // 0.005 SOL
  entryWindowSlots: 6,
  minCreatorBuyLamports: (15n * LAMPORTS_PER_SOL) / 100n, // 0.15 SOL
  maxCreatorBuyLamports: (25n * LAMPORTS_PER_SOL) / 10n, // 2.5 SOL
  minRealReserveLamports: 3n * LAMPORTS_PER_SOL,
  maxRealReserveLamports: 50n * LAMPORTS_PER_SOL,
  minTrades: 4,
  minDistinctBuyers: 5,
  takeProfitBps: 12000n, // liquidate at >= 120% of spent
  stopLossBps: 8500n, // liquidate at <= 85% of spent
  maxHoldSlots: 300,
  maxSlippageBps: 10000,
};

await runBot(createStrategy(DEFAULT_PARAMS));
