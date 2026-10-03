import type { Enricher } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { buildSnapshot } from './context.js'
import type { EmitAlert } from './detector.js'
import { buildCandleWindow, type Strategy } from './strategy.js'
import { firstSeenMinute, isNewToken } from './tokenAge.js'

// ---- Tunable parameters, ported 1:1 from the original n8n Code node ----
const MOMENTUM_LOOKBACK = 4 // candles back to measure gain over
const MIN_GAIN_PCT = 0.4 // required gain over the lookback window (0.40 = 40%)
const MIN_GREEN_COUNT = 3 // out of CANDLES_IN_WINDOW candles must be green
const VOLUME_SUSTAIN_MULT = 0.8 // current volume must be >= this x the avg volume of the prior lookback window
const CANDLES_IN_WINDOW = MOMENTUM_LOOKBACK + 1 // prior candles (4) + the current one (1) = 5

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Early Momentum: sustained directional acceleration, ported from an n8n
 * Code node. Unlike a coil/squeeze detector, this does not require a prior
 * quiet base — it is designed to fire even in a token's first few minutes.
 *
 * Fires when, over the trailing CANDLES_IN_WINDOW (5) one-minute candles:
 * 1. price gained at least MIN_GAIN_PCT from the oldest candle's close to
 *    the current candle's close;
 * 2. at least MIN_GREEN_COUNT of the 5 candles closed green (close > open);
 * 3. the current candle's volume is still at least VOLUME_SUSTAIN_MULT times
 *    the average volume of the 4 prior candles — the move hasn't gone quiet.
 *
 * Candles here are real OHLCV (see strategy.ts) — open is the minute's own
 * first trade, not approximated from the prior minute's close.
 */
export const earlyMomentumStrategy: Strategy = {
  name: 'early_momentum',
  minWindowMinutes: CANDLES_IN_WINDOW,

  evaluate(window) {
    if (window.length < this.minWindowMinutes) return null

    const candles = window.slice(-CANDLES_IN_WINDOW)
    const current = candles[candles.length - 1]!
    const priorCandles = candles.slice(0, -1)

    const gainStartClose = priorCandles[0]!.closePrice
    if (gainStartClose <= 0) return null
    const gainPct = (current.closePrice - gainStartClose) / gainStartClose

    const greenCount = candles.filter((c) => c.closePrice > c.openPrice).length

    const avgPriorVol = average(priorCandles.map((c) => c.volumeUsd))
    const volumeSustained = avgPriorVol > 0 && current.volumeUsd >= avgPriorVol * VOLUME_SUSTAIN_MULT

    if (gainPct < MIN_GAIN_PCT || greenCount < MIN_GREEN_COUNT || !volumeSustained) return null

    return {
      reason: 'early_momentum',
      gainPct,
      greenCount,
      candleCount: CANDLES_IN_WINDOW,
      volumeUsd: current.volumeUsd,
      avgPriorVolumeUsd: avgPriorVol,
    }
  },
}

/** One alert per token per this many seconds. Short on purpose: this is meant
 *  to be a fast, reactive signal, not a slow lead-up pattern. */
const COOLDOWN_S = 20 * 60

/** Live wrapper around {@link earlyMomentumStrategy}: age gating, per-token
 *  cooldown, enrichment, and alert delivery. The strategy logic itself lives
 *  entirely in earlyMomentumStrategy.evaluate(), shared unchanged with
 *  scripts/backtest.ts. */
export class EarlyMomentumDetector {
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
        logger.warn({ token, err: String(error) }, 'early momentum evaluation failed')
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
    if (closedMinute - firstSeen < earlyMomentumStrategy.minWindowMinutes) return
    if (!isNewToken(this.store, token, nowS)) return

    const cooldownAt = this.lastAlert.get(token)
    if (cooldownAt !== undefined && nowS - cooldownAt < COOLDOWN_S) return

    const windowStart = closedMinute - earlyMomentumStrategy.minWindowMinutes + 1
    const window = buildCandleWindow(this.store, token, windowStart, closedMinute)
    if (window === null) return

    const signal = earlyMomentumStrategy.evaluate(window)
    if (signal === null) return
    this.lastAlert.set(token, nowS)

    const current = window[window.length - 1]!
    const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, current.closePrice, nowMinute)
    this.alerts++
    await this.emit({
      kind: 'early_momentum',
      token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: nowS,
      context: snapshot.context,
      gainPct: signal.gainPct as number,
      greenCount: signal.greenCount as number,
      candleCount: signal.candleCount as number,
      volumeUsd: signal.volumeUsd as number,
      avgPriorVolumeUsd: signal.avgPriorVolumeUsd as number,
    })
  }
}
