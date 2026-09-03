import type { Enricher } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { computeBaseline } from './baseline.js'
import { buildSnapshot } from './context.js'
import type { EmitAlert } from './detector.js'
import { firstSeenMinute, isNewToken } from './tokenAge.js'

/** Total lookback the pattern is judged over, split into two equal halves. */
const WINDOW_MINUTES = 20
const HALF_MINUTES = WINDOW_MINUTES / 2
/** How far back of baseline history to compare the window's volume against. */
const BASELINE_LOOKBACK_MINUTES = 60
/** One alert per token per this many seconds — this is a slow-forming
 *  pattern, so refiring every tick while it holds would be pure noise. */
const COOLDOWN_S = 90 * 60

// Tuned deliberately strict: fewer, more reliable alerts over catching every
// possible lead-up, per how this detector was specced.
const MIN_SWAPS = 12
const MIN_ABS_VOLUME_USD = 500
const MIN_BUY_RATIO = 0.62
const MIN_SECOND_HALF_BUY_RATIO = 0.65
const MIN_VOLUME_TREND_MULTIPLE = 1.6
const MAX_PRICE_RANGE_PCT = 10
const MIN_BASELINE_MULTIPLE = 1.3

/**
 * Accumulation detector: a lead-up signal, not a confirmation signal. Fires
 * when, over a trailing WINDOW_MINUTES window:
 *
 * 1. price stays range-bound (see MAX_PRICE_RANGE_PCT) — no move has
 *    started yet;
 * 2. buys dominate the flow, and more so in the second half of the window
 *    than the first — buy pressure is building, not just present;
 * 3. volume itself is accelerating (second half meaningfully above the
 *    first), and the window's average sits well above the token's own
 *    trailing baseline — this is unusual activity for this token, not its
 *    normal background noise.
 *
 * This is inherently a pattern that "often precedes a move," not a
 * prediction: it will occasionally fire on tokens that never break out, or
 * that break down instead of up. It complements {@link SmaCrossDetector},
 * which only confirms a move once one is already underway.
 */
export class AccumulationDetector {
  private readonly lastAlert = new Map<string, number>()
  alerts = 0

  constructor(
    private readonly store: Store,
    private readonly meta: TokenMetaCache,
    private readonly enricher: Enricher,
    private readonly emit: EmitAlert,
  ) {}

  async evaluate(tokens: string[], nowS: number): Promise<void> {
    const nowMinute = Math.floor(nowS / 60)
    for (const token of tokens) {
      try {
        await this.evaluateToken(token, nowS, nowMinute)
      } catch (error) {
        logger.warn({ token, err: String(error) }, 'accumulation evaluation failed')
      }
    }
    for (const [token, at] of this.lastAlert) {
      if (nowS - at > 4 * 3600) this.lastAlert.delete(token)
    }
  }

  private async evaluateToken(token: string, nowS: number, nowMinute: number): Promise<void> {
    const closedMinute = nowMinute - 1

    const firstSeen = firstSeenMinute(this.store, token)
    if (firstSeen === null) return
    // Needs a full window of real history — a token younger than the window
    // itself cannot show a "before" and "after" half.
    if (closedMinute - firstSeen < WINDOW_MINUTES) return
    if (!isNewToken(this.store, token, nowS)) return

    const cooldownAt = this.lastAlert.get(token)
    if (cooldownAt !== undefined && nowS - cooldownAt < COOLDOWN_S) return

    const windowStart = closedMinute - WINDOW_MINUTES + 1
    const buckets = this.store.getBuckets(token, windowStart, closedMinute)

    const closes: number[] = []
    const volumes: number[] = []
    const buys: number[] = []
    const sells: number[] = []
    let lastClose: number | null = null
    for (let m = windowStart; m <= closedMinute; m++) {
      const b = buckets.get(m)
      if (b && b.closePrice > 0) {
        lastClose = b.closePrice
        closes.push(b.closePrice)
        volumes.push(b.volumeUsd)
        buys.push(b.buys)
        sells.push(b.sells)
      } else if (lastClose !== null) {
        // No trade this minute: flat candle at the last known price, no flow.
        closes.push(lastClose)
        volumes.push(0)
        buys.push(0)
        sells.push(0)
      } else {
        return // no price history yet this far back
      }
    }

    const firstHalfVolume = sum(volumes.slice(0, HALF_MINUTES))
    const secondHalfVolume = sum(volumes.slice(HALF_MINUTES))
    const totalVolume = firstHalfVolume + secondHalfVolume
    if (totalVolume < MIN_ABS_VOLUME_USD) return

    const totalBuys = sum(buys)
    const totalSells = sum(sells)
    const totalSwaps = totalBuys + totalSells
    if (totalSwaps < MIN_SWAPS) return
    const buyRatio = totalBuys / totalSwaps
    if (buyRatio < MIN_BUY_RATIO) return

    const secondHalfBuys = sum(buys.slice(HALF_MINUTES))
    const secondHalfSells = sum(sells.slice(HALF_MINUTES))
    const secondHalfSwaps = secondHalfBuys + secondHalfSells
    if (secondHalfSwaps === 0) return
    const secondHalfBuyRatio = secondHalfBuys / secondHalfSwaps
    if (secondHalfBuyRatio < MIN_SECOND_HALF_BUY_RATIO) return

    // Floor the denominator so a near-zero first half doesn't produce a
    // meaningless, enormous "trend multiple".
    const volumeTrendMultiple = secondHalfVolume / Math.max(firstHalfVolume, MIN_ABS_VOLUME_USD / 4)
    if (volumeTrendMultiple < MIN_VOLUME_TREND_MULTIPLE) return

    const priceMax = Math.max(...closes)
    const priceMin = Math.min(...closes)
    const priceMean = closes.reduce((a, b) => a + b, 0) / closes.length
    if (priceMean <= 0) return
    const priceRangePct = ((priceMax - priceMin) / priceMean) * 100
    if (priceRangePct > MAX_PRICE_RANGE_PCT) return

    // Baseline: the token's own trailing normal, from BEFORE this window, so
    // the comparison isn't circular. Skipped (never approved) if there isn't
    // enough prior history to trust the comparison.
    const baselineTo = windowStart - 1
    const baselineFrom = baselineTo - BASELINE_LOOKBACK_MINUTES + 1
    if (baselineTo - baselineFrom + 1 < 3) return
    const baselineBuckets = this.store.getBuckets(token, baselineFrom, baselineTo)
    const baseline = computeBaseline(baselineBuckets, baselineFrom, baselineTo)
    const avgWindowVolPerMin = totalVolume / WINDOW_MINUTES
    if (avgWindowVolPerMin < baseline.volPerMin * MIN_BASELINE_MULTIPLE) return

    this.lastAlert.set(token, nowS)

    const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, closes[closes.length - 1]!, nowMinute)
    this.alerts++
    await this.emit({
      kind: 'accumulation',
      token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: nowS,
      context: snapshot.context,
      buyRatio,
      volumeUsd: totalVolume,
      volumeTrendMultiple,
      priceRangePct,
      windowMinutes: WINDOW_MINUTES,
    })
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}
