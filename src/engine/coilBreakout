import type { Enricher } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { buildSnapshot } from './context.js'
import type { EmitAlert } from './detector.js'
import { buildCandleWindow, type Strategy } from './strategy.js'
import { firstSeenMinute, isNewToken } from './tokenAge.js'

// ---- Tunable parameters, ported 1:1 from the n8n "coil breakout v4" Code node ----
const COIL_LOOKBACK = 8
const BASE_LOOKBACK = 20
const TIGHTNESS_ATR_MULT = 4
const VOLUME_MULTIPLIER = 1.3
const BREAKOUT_ATR_MULT = 0.8
const DRIFT_MAX_MULT = 1.0

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Coil breakout: adaptive volatility-contraction breakout, ported from an
 * n8n Code node. This is the opposite of the Accumulation detector in one
 * key way — it fires at the moment a tight, flat coil *breaks*, not before
 * or during the lead-up.
 *
 * Over the trailing COIL_LOOKBACK (8) candles before the current one:
 * 1. "tight" — the spread between the highest and lowest close in the coil
 *    is at most TIGHTNESS_ATR_MULT times the coil's own average candle
 *    range (a proxy for its typical ATR);
 * 2. "flat" — the average close of the coil's second half hasn't drifted
 *    from its first half by more than DRIFT_MAX_MULT times that same range;
 * 3. the current candle's close clears the coil's highest close by at least
 *    BREAKOUT_ATR_MULT times the coil's range — a real break, not noise;
 * 4. the current candle's volume is at least VOLUME_MULTIPLIER times the
 *    average volume of the trailing BASE_LOOKBACK (20) candles — the
 *    breakout has real volume behind it.
 *
 * Needs real intra-minute high/low prices, not just closes (see the
 * `highPrice`/`lowPrice` fields added to minute buckets alongside this).
 * History written before that existed has no range data and is correctly
 * skipped by the avgCoilRange/avgBaseVolume > 0 guards below.
 */
export const coilBreakoutStrategy: Strategy = {
  name: 'coil_breakout',
  minWindowMinutes: BASE_LOOKBACK + 1, // the larger of the two lookbacks, plus the current candle

  evaluate(window) {
    if (window.length < this.minWindowMinutes) return null

    const current = window[window.length - 1]!
    const coilWindow = window.slice(-(COIL_LOOKBACK + 1), -1)
    const baseWindow = window.slice(-(BASE_LOOKBACK + 1), -1)

    const coilCloses = coilWindow.map((c) => c.closePrice)
    const coilRanges = coilWindow.map((c) => c.highPrice - c.lowPrice)
    const baseVols = baseWindow.map((c) => c.volumeUsd)

    const avgCoilRange = average(coilRanges)
    const avgBaseVolume = average(baseVols)
    if (avgCoilRange <= 0 || avgBaseVolume <= 0) return null

    const closeHigh = Math.max(...coilCloses)
    const closeLow = Math.min(...coilCloses)
    const closeRange = closeHigh - closeLow
    const isTight = closeRange / avgCoilRange <= TIGHTNESS_ATR_MULT

    const half = Math.floor(coilCloses.length / 2)
    const firstHalfAvg = average(coilCloses.slice(0, half))
    const secondHalfAvg = average(coilCloses.slice(coilCloses.length - half))
    const drift = Math.abs(secondHalfAvg - firstHalfAvg)
    const isFlat = drift / avgCoilRange <= DRIFT_MAX_MULT

    const clearance = current.closePrice - closeHigh
    const breaksOut = clearance >= avgCoilRange * BREAKOUT_ATR_MULT

    const hasVolumeSpike = current.volumeUsd >= avgBaseVolume * VOLUME_MULTIPLIER

    if (!isTight || !isFlat || !breaksOut || !hasVolumeSpike) return null

    return {
      reason: 'coil_breakout',
      clearancePct: (clearance / closeHigh) * 100,
      volumeMultiple: current.volumeUsd / avgBaseVolume,
      volumeUsd: current.volumeUsd,
      coilRangePct: (avgCoilRange / closeHigh) * 100,
    }
  },
}

/** One alert per token per this many seconds — a breakout is a one-time event. */
const COOLDOWN_S = 15 * 60

/** Live wrapper around {@link coilBreakoutStrategy}: age gating, cooldown,
 *  enrichment, and delivery. See earlyMomentum.ts for the same pattern. */
export class CoilBreakoutDetector {
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
        logger.warn({ token, err: String(error) }, 'coil breakout evaluation failed')
      }
    }
    for (const [token, at] of this.lastAlert) {
      if (nowS - at > 2 * 3600) this.lastAlert.delete(token)
    }
  }

  private async evaluateToken(token: string, nowS: number, nowMinute: number): Promise<void> {
    const closedMinute = nowMinute - 1

    const firstSeen = firstSeenMinute(this.store, token)
    if (firstSeen === null) return
    if (closedMinute - firstSeen < coilBreakoutStrategy.minWindowMinutes) return
    if (!isNewToken(this.store, token, nowS)) return

    const cooldownAt = this.lastAlert.get(token)
    if (cooldownAt !== undefined && nowS - cooldownAt < COOLDOWN_S) return

    const windowStart = closedMinute - coilBreakoutStrategy.minWindowMinutes + 1
    const window = buildCandleWindow(this.store, token, windowStart, closedMinute)
    if (window === null) return

    const signal = coilBreakoutStrategy.evaluate(window)
    if (signal === null) return
    this.lastAlert.set(token, nowS)

    const current = window[window.length - 1]!
    const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, current.closePrice, nowMinute)
    this.alerts++
    await this.emit({
      kind: 'coil_breakout',
      token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: nowS,
      context: snapshot.context,
      clearancePct: signal.clearancePct as number,
      volumeMultiple: signal.volumeMultiple as number,
      volumeUsd: signal.volumeUsd as number,
      coilRangePct: signal.coilRangePct as number,
    })
  }
}
