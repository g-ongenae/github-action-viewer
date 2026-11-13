/** Share of the hourly quota left untouched for the other tools using the same token. */
export const QUOTA_RESERVE_RATIO = 0.2;

export interface PacingInput {
  /** Requests the latest collection spent: sent, minus the free `304 Not Modified` answers. */
  readonly spent: number;
  /** The core quota after the latest collection; null if GitHub sent none. */
  readonly quota: {
    readonly limit: number;
    readonly remaining: number;
    /** When the quota is refilled, in milliseconds since the epoch. */
    readonly resetAt: number;
  } | null;
  /** Set after a rate limit: send nothing before this time (milliseconds since the epoch). */
  readonly retryAt: number | null;
  /** The configured interval, in milliseconds. */
  readonly baseIntervalMs: number;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

export interface Pacing {
  /** Delay before the next collection, in milliseconds; never below the base interval. */
  readonly delayMs: number;
  readonly reason: 'base' | 'budget' | 'rate_limited';
}

/**
 * Delay before the next collection, so that polling never exhausts the API quota.
 *
 * Assuming the next collections cost what the latest one did, polling at the base interval until
 * the quota resets spends `spent × untilReset / base`. When that exceeds what may be spent —
 * `remaining` minus a reserve of {@link QUOTA_RESERVE_RATIO} of the limit for other tools — the
 * interval is stretched to `untilReset × spent / budget`, at most up to the reset (always, when
 * nothing may be spent). A collection that cost nothing (all `304`s) never stretches it. A rate limit's `retryAt`
 * always wins.
 */
export function paceNextPoll(input: PacingInput): Pacing {
  const { spent, quota, retryAt, baseIntervalMs, now } = input;
  const base = Math.max(0, baseIntervalMs);

  if (retryAt !== null && retryAt - now > base) {
    return { delayMs: retryAt - now, reason: 'rate_limited' };
  }
  if (quota === null || spent <= 0) {
    return { delayMs: base, reason: 'base' };
  }
  const untilReset = quota.resetAt - now;
  if (untilReset <= base) {
    return { delayMs: base, reason: 'base' };
  }

  const budget = quota.remaining - quota.limit * QUOTA_RESERVE_RATIO;
  // Never past the reset: the quota is full again then.
  const stretched =
    budget <= 0 ? untilReset : Math.min(untilReset, Math.ceil((untilReset * spent) / budget));
  return stretched > base
    ? { delayMs: stretched, reason: 'budget' }
    : { delayMs: base, reason: 'base' };
}
