import { coilBreakoutStrategy } from './coilBreakout.js'
import { earlyMomentumStrategy } from './earlyMomentum.js'
import type { Strategy } from './strategy.js'

/**
 * Every strategy usable by scripts/backtest.ts, by name. A strategy's pure
 * evaluate() logic lives next to its live detector (see earlyMomentum.ts for
 * the pattern) — add a new strategy by writing that pair, then listing its
 * evaluate function here under a unique name.
 */
export const STRATEGIES: Record<string, Strategy> = {
  [earlyMomentumStrategy.name]: earlyMomentumStrategy,
  [coilBreakoutStrategy.name]: coilBreakoutStrategy,
}
