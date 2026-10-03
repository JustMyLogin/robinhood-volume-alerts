/**
 * Strategy backtester: replays a strategy's evaluate() against minute
 * buckets already sitting in the bot's own SQLite file. No chain access, no
 * API key, no separate data source — it reads exactly the history the live
 * bot (or a dry run) has already collected.
 *
 *   npm run backtest -- --strategy early_momentum
 *   npm run backtest -- --strategy early_momentum --token 0xabc...
 *   npm run backtest -- --strategy early_momentum --horizon 60 --limit 200
 *   npm run backtest -- --strategy early_momentum --db ./data/volume-alerts.db
 *
 * For every signal found, records the price at the signal and the price
 * `horizon` minutes later (when that much history exists) to report a rough
 * win rate and average forward return. This is a sanity check on a
 * strategy's historical hit rate, not a substitute for watching it live.
 */
import { Store } from '../src/db.js'
import { fillCandleWindow } from '../src/engine/strategy.js'
import { STRATEGIES } from '../src/engine/strategies.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback
}
function numArg(name: string, fallback: number): number {
  const v = Number(arg(name, String(fallback)))
  return Number.isFinite(v) ? v : fallback
}

const dbPath = arg('db', process.env.DB_PATH?.trim() || './data/volume-alerts.db')
const strategyName = arg('strategy', 'early_momentum')
const onlyToken = arg('token', '').toLowerCase() || null
const horizon = numArg('horizon', 30) // minutes forward to measure return
const limitTokens = numArg('limit', 0) // 0 = no cap

const strategy = STRATEGIES[strategyName]
if (!strategy) {
  console.error(`Unknown strategy "${strategyName}". Available: ${Object.keys(STRATEGIES).join(', ')}`)
  process.exit(1)
}

// Defaults here are unused for backtesting (no chats, no gating) but Store's
// constructor needs them to seed its own settings-defaults table.
const store = new Store(dbPath, {
  spikeX: 3,
  minVolumeUsd: 500,
  minSwaps: 3,
  newTokens: true,
  whaleMinUsd: 5000,
  priceMovePct: 25,
  rugDropPct: 40,
})

const tokens = onlyToken ? [onlyToken] : store.allTrackedTokens()
const scanTokens = limitTokens > 0 ? tokens.slice(0, limitTokens) : tokens

console.log(`Backtesting "${strategy.name}" over ${scanTokens.length} token(s), horizon +${horizon}m\n`)

interface Hit {
  token: string
  minute: number
  priceAt: number
  returnPct: number | null
}

const hits: Hit[] = []
const nowMinute = Math.floor(Date.now() / 1000 / 60)

for (const token of scanTokens) {
  const bucketsMap = store.getBuckets(token, 0, nowMinute)
  if (bucketsMap.size === 0) continue

  const minutesKnown = [...bucketsMap.keys()].sort((a, b) => a - b)
  const firstMinute = minutesKnown[0]!
  const lastMinute = minutesKnown[minutesKnown.length - 1]!

  // Fetched and forward-filled once per token, then sliced in memory below —
  // not re-queried per minute, so this stays fast even on long histories.
  const fullWindow = fillCandleWindow(bucketsMap, firstMinute, lastMinute)
  if (fullWindow === null) continue

  for (let i = strategy.minWindowMinutes - 1; i < fullWindow.length; i++) {
    const slice = fullWindow.slice(i - strategy.minWindowMinutes + 1, i + 1)
    const signal = strategy.evaluate(slice)
    if (signal === null) continue

    const priceAt = slice[slice.length - 1]!.closePrice
    const futureIndex = i + horizon
    const priceAfter = futureIndex < fullWindow.length ? fullWindow[futureIndex]!.closePrice : null
    const returnPct = priceAfter !== null ? ((priceAfter - priceAt) / priceAt) * 100 : null

    hits.push({ token, minute: fullWindow[i]!.minute, priceAt, returnPct })
  }
}

console.log(`${hits.length} signal(s) found.\n`)

const withReturn = hits.filter((h): h is Hit & { returnPct: number } => h.returnPct !== null)
if (withReturn.length > 0) {
  const wins = withReturn.filter((h) => h.returnPct > 0)
  const avgReturn = withReturn.reduce((a, h) => a + h.returnPct, 0) / withReturn.length
  const sorted = [...withReturn].sort((a, b) => a.returnPct - b.returnPct)
  const median = sorted[Math.floor(sorted.length / 2)]!.returnPct

  console.log(`Of ${withReturn.length} signal(s) with +${horizon}m data available:`)
  console.log(`  Win rate:   ${((wins.length / withReturn.length) * 100).toFixed(1)}%`)
  console.log(`  Avg return: ${avgReturn.toFixed(1)}%`)
  console.log(`  Median:     ${median.toFixed(1)}%`)
  console.log(`  Best:       ${sorted[sorted.length - 1]!.returnPct.toFixed(1)}%`)
  console.log(`  Worst:      ${sorted[0]!.returnPct.toFixed(1)}%`)
} else {
  console.log(`No signal had +${horizon}m of forward data yet to measure a return.`)
}

console.log('\nFirst 20 signals:')
for (const h of hits.slice(0, 20)) {
  const when = new Date(h.minute * 60 * 1000).toISOString()
  const ret = h.returnPct !== null ? `${h.returnPct.toFixed(1)}%` : 'n/a'
  console.log(`  ${h.token}  ${when}  entry $${h.priceAt}  +${horizon}m: ${ret}`)
}

store.close()
