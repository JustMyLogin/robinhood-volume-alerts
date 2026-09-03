import type { Enricher } from '../chain/enrich.js'
import type { TokenMetaCache } from '../chain/token-meta.js'
import type { Store } from '../db.js'
import { logger } from '../logger.js'
import { buildSnapshot } from './context.js'
import type { EmitAlert } from './detector.js'

const SMA_PERIOD = 9
/** Only evaluate tokens younger than this — the "new token" breakout case. */
const MAX_AGE_MINUTES = 120

/** Simple moving average of the trailing SMA_PERIOD values. */
function sma(values: number[]): number | null {
  if (values.length < SMA_PERIOD) return null
  const window = values.slice(-SMA_PERIOD)
  return window.reduce((a, b) => a + b, 0) / SMA_PERIOD
}

/**
 * SMA9 crossover detector: fires when a token's minute close crosses above
 * its own trailing 9-minute close SMA on the same minute its volume is
 * above its own 9-minute volume SMA — breakout with volume confirmation.
 *
 * Restricted to tokens younger than MAX_AGE_MINUTES: older, established
 * tokens chopping around their SMA are noise for this signal, which is
 * meant to catch early breakouts on new launches.
 *
 * Runs on the same 15s tick as the spike detector, over closed minute
 * buckets only, so the SMA and the bar it is judged against never move
 * under each other mid-evaluation.
 */
export class SmaCrossDetector {
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
        logger.warn({ token, err: String(error) }, 'sma cross evaluation failed')
      }
    }
    for (const [token, at] of this.lastAlert) {
      if (nowS - at > 2 * 3600) this.lastAlert.delete(token)
    }
  }

  /** Token's recorded first-seen minute, falling back to its earliest stored bucket. */
  private firstSeenMinute(token: string): number | null {
    const row = this.store.getToken(token)
    if (row?.firstSeenS != null) return Math.floor(row.firstSeenS / 60)
    return this.store.earliestBucketMinute(token)
  }

  private async evaluateToken(token: string, nowS: number, nowMinute: number): Promise<void> {
    const closedMinute = nowMinute - 1

    const firstSeen = this.firstSeenMinute(token)
    if (firstSeen === null || closedMinute - firstSeen > MAX_AGE_MINUTES) return

    const fromMinute = closedMinute - SMA_PERIOD
    const buckets = this.store.getBuckets(token, fromMinute, closedMinute)

    const closes: number[] = []
    const volumes: number[] = []
    let lastClose: number | null = null
    for (let m = fromMinute; m <= closedMinute; m++) {
      const b = buckets.get(m)
      if (b && b.closePrice > 0) {
        lastClose = b.closePrice
        closes.push(b.closePrice)
        volumes.push(b.volumeUsd)
      } else if (lastClose !== null) {
        // No trade this minute: flat candle at the last known price, zero volume.
        closes.push(lastClose)
        volumes.push(0)
      } else {
        return // not enough price history yet this far back
      }
    }

    const currentClose = closes[closes.length - 1]!
    const currentVolume = volumes[volumes.length - 1]!
    const priorCloses = closes.slice(0, -1)

    const priceSmaNow = sma(closes)
    const priceSmaPrior = sma(priorCloses)
    const volumeSmaNow = sma(volumes)
    if (priceSmaNow === null || priceSmaPrior === null || volumeSmaNow === null) return

    const priorClose = priorCloses[priorCloses.length - 1]!
    const crossedUp = priorClose <= priceSmaPrior && currentClose > priceSmaNow
    const volumeConfirmed = currentVolume > volumeSmaNow
    if (!crossedUp || !volumeConfirmed) return

    // One alert per token per 30 minutes, so hugging the SMA doesn't refire every tick.
    const lastAt = this.lastAlert.get(token)
    if (lastAt !== undefined && nowS - lastAt < 1800) return
    this.lastAlert.set(token, nowS)

    const snapshot = await buildSnapshot(this.store, this.meta, this.enricher, token, currentClose, nowMinute)
    this.alerts++
    await this.emit({
      kind: 'sma_cross',
      token,
      symbol: snapshot.symbol,
      name: snapshot.name,
      at: nowS,
      context: snapshot.context,
      closePrice: currentClose,
      sma9: priceSmaNow,
      volumeUsd: currentVolume,
      volumeSma9: volumeSmaNow,
    })
  }
}
