import type { Store } from '../db.js'

/** Tokens older than this are excluded from every "new token only" detector. */
export const MAX_NEW_TOKEN_AGE_MINUTES = 120

/**
 * A token's first-seen minute: its recorded launch time when the launch
 * watcher caught it live, falling back to the earliest minute bucket ever
 * stored for it — this covers tokens that existed before this bot's uptime,
 * which the launch watcher never had a chance to see launch.
 */
export function firstSeenMinute(store: Store, token: string): number | null {
  const row = store.getToken(token)
  if (row?.firstSeenS != null) return Math.floor(row.firstSeenS / 60)
  return store.earliestBucketMinute(token)
}

/** Whether `token` is younger than MAX_NEW_TOKEN_AGE_MINUTES, as of `nowS`. */
export function isNewToken(store: Store, token: string, nowS: number): boolean {
  const seen = firstSeenMinute(store, token)
  if (seen === null) return false
  return Math.floor(nowS / 60) - seen <= MAX_NEW_TOKEN_AGE_MINUTES
}
