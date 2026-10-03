import { parseAbiItem } from 'viem'
import type { Address } from 'viem'

/**
 * pons launchpad on Robinhood Chain (docs.ponsfamily.com). Only the active
 * factory is watched — the legacy factory stopped serving new launches once
 * the active one shipped, so it has nothing new to emit.
 */
export const PONS_ACTIVE_FACTORY: Address = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'
/** Block the active factory was deployed at. Kept for any future backfill. */
export const PONS_DEPLOY_BLOCK = 8_991_118n

/**
 * TokenLaunched on the active factory. Tokens launch directly into a locked
 * Uniswap v3 pool quoted in WETH — no bonding curve, so `pool` is always
 * populated at launch time (unlike NOXA/Odyssey curve launches).
 */
export const ponsTokenLaunchedEvent = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)',
)

/**
 * pons has no on-chain graduation event: trading continues in the same pool
 * once the paired-WETH threshold is reached, so graduation must be read via
 * this view function rather than watched as a log. `threshold` is read live
 * per token rather than hardcoded, since pons documents it as configurable
 * per launch (default 4.2 ETH).
 */
export const ponsGraduationStatusAbi = parseAbiItem(
  'function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)',
)
