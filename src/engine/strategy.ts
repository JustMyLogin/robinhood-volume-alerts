import type { MinuteBucket, Store } from '../db.js'

/**
 * A minimal, DB-agnostic shape for one minute of a token's history. Strategies
 * only ever see this — never the Store, never Telegram, never cooldowns —
 * which is what lets the exact same evaluate() function run both live (via a
 * thin detector wrapper, see earlyMomentum.ts) and offline (via
 * scripts/backtest.ts, reading straight from the bot's own SQLite file — no
 * separate data source or API key needed for either).
 */
/**
 * A genuine one-minute OHLCV candle. Every field is real trade data — open
 * is the first trade's price, close the last, high/low the extremes — none
 * of it synthesized from neighboring minutes. Any strategy needing OHLC
 * (coils, wicks, gap-ups, whatever) can rely on these fields directly rather
 * than approximating them itself.
 */
export interface StrategyCandle {
  /** Unix minute index (minutes since epoch), not a timestamp in seconds. */
  minute: number
  openPrice: number
  closePrice: number
  highPrice: number
  lowPrice: number
  volumeUsd: number
  buys: number
  sells: number
}

/** What a strategy reports when it fires. Shape beyond `reason` is strategy-specific. */
export interface StrategySignal {
  reason: string
  [key: string]: unknown
}

/**
 * A strategy is a pure function of a candle window. Register new ones in
 * strategies.ts; each gets both a live detector (wrapping evaluate() with
 * age gating, cooldowns, and alert delivery) and automatic coverage by the
 * backtest script, with no duplicated logic between the two.
 */
export interface Strategy {
  name: string
  /** Calendar minutes of real history required before evaluate() is meaningful. */
  minWindowMinutes: number
  /**
   * `window` is ordered oldest → newest and ends at the minute being judged
   * (the last element). Returns a signal, or null if the strategy doesn't fire.
   */
  evaluate(window: StrategyCandle[]): StrategySignal | null
}

/**
 * Forward-fills a minute-indexed bucket map into an ordered, gapless
 * StrategyCandle[]: a missing minute becomes a flat candle at the last known
 * price with zero volume, matching the convention every other detector in
 * this codebase already uses. Pure — no DB access — so the backtest script
 * can fetch a token's whole history once and call this directly, while live
 * detectors use {@link buildCandleWindow} below for the same result against
 * a live Store. Returns null if there is no price history at all this far back.
 */
export function fillCandleWindow(
  buckets: Map<number, MinuteBucket>,
  fromMinute: number,
  toMinute: number,
): StrategyCandle[] | null {
  const window: StrategyCandle[] = []
  let lastClose: number | null = null
  for (let m = fromMinute; m <= toMinute; m++) {
    const b = buckets.get(m)
    if (b && b.closePrice > 0) {
      lastClose = b.closePrice
      // open/high/low are 0 on buckets written before that tracking existed;
      // treat that the same as "no data" by falling back to the close, which
      // gives a correctly flat candle rather than a bogus range against 0.
      const open = b.openPrice > 0 ? b.openPrice : b.closePrice
      const high = b.highPrice > 0 ? b.highPrice : b.closePrice
      const low = b.lowPrice > 0 ? b.lowPrice : b.closePrice
      window.push({
        minute: m,
        openPrice: open,
        closePrice: b.closePrice,
        highPrice: high,
        lowPrice: low,
        volumeUsd: b.volumeUsd,
        buys: b.buys,
        sells: b.sells,
      })
    } else if (lastClose !== null) {
      // No trade this minute: a flat candle at the last known price — open,
      // close, high and low all equal, zero volume.
      window.push({
        minute: m,
        openPrice: lastClose,
        closePrice: lastClose,
        highPrice: lastClose,
        lowPrice: lastClose,
        volumeUsd: 0,
        buys: 0,
        sells: 0,
      })
    } else {
      return null
    }
  }
  return window
}

/** Convenience for live detectors: fetches the range from the store, then forward-fills it. */
export function buildCandleWindow(
  store: Store,
  token: string,
  fromMinute: number,
  toMinute: number,
): StrategyCandle[] | null {
  return fillCandleWindow(store.getBuckets(token, fromMinute, toMinute), fromMinute, toMinute)
}
