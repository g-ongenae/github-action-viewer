import type { Config } from '../core/config.ts';
import type { RateLimitStatus } from '../github/client.ts';
import type { CollectionResult } from '../github/collect.ts';
import { GitHubError, RateLimitError } from '../github/errors.ts';
import { carryOver, type Published } from './carry-over.ts';
import { paceNextPoll } from './pacing.ts';
import type { PollInterval, Quota, RateLimits, ServerStatus, Staleness } from './payload.ts';

/** Timers and clock, injectable so that tests are deterministic. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Longest delay a Node timer holds (2^31 − 1 ms, about 24.8 days); a longer one fires after 1 ms.
 * Longer waits are made of several timers.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Longest wait between two attempts while collections fail (unless the base interval is longer). */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** The poller's part of the payload: the snapshot and everything but the configuration status. */
export interface PollState {
  readonly snapshot: Published['snapshot'] | null;
  readonly status: Omit<ServerStatus, 'config'>;
}

/** What happened in one collection, for the log. */
export type PollOutcome =
  | {
      readonly kind: 'success';
      readonly result: CollectionResult;
      /** Repositories shown, in whole or in part, from earlier collections. */
      readonly carried: number;
    }
  | {
      readonly kind: 'failure';
      /** What the page shows. */
      readonly message: string;
      /** The error itself, for the log. */
      readonly error: unknown;
      /** Consecutive failed collections, this one included. */
      readonly failures: number;
    };

export interface PollerOptions {
  /** Collects a snapshot; must honour the signal. */
  readonly collect: (config: Config, signal: AbortSignal) => Promise<CollectionResult>;
  /** The configuration to use, read at the start of each collection. */
  readonly config: () => Config;
  /** Called after each collection, and when the schedule changes. */
  readonly onUpdate: (state: PollState, outcome: PollOutcome | null) => void;
  readonly clock?: Clock;
}

/**
 * Collects in a loop. Collections never overlap: the next one is scheduled when the previous one
 * ends, after a delay that respects the API quota ({@link paceNextPoll}) and any rate limit, and
 * that backs off exponentially while whole collections fail. The published snapshot always
 * survives failures: repositories a collection could not refresh keep their previous state
 * ({@link carryOver}), and a failed collection keeps the last good snapshot, flagged stale.
 */
export class Poller {
  readonly #options: PollerOptions;
  readonly #clock: Clock;
  #timer: unknown = null;
  #running: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #stopped = false;
  #started = false;
  /** A collection was requested while one was running: start another as soon as it ends. */
  #rerun = false;

  #published: Published | null = null;
  #lastCheckedAt: string | null = null;
  #lastSuccessAt: string | null = null;
  #nextPollAt: string | null = null;
  #stale: Staleness | null = null;
  #failures = 0;
  #interval: PollInterval;
  #rateLimits: RateLimits = { core: null, search: null, retryAt: null };
  #retryAt: number | null = null;

  constructor(options: PollerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    const baseSeconds = options.config().pollIntervalSeconds;
    this.#interval = { baseSeconds, currentSeconds: baseSeconds, reason: 'base' };
  }

  get state(): PollState {
    return {
      snapshot: this.#published?.snapshot ?? null,
      status: {
        lastCheckedAt: this.#lastCheckedAt,
        lastSuccessAt: this.#lastSuccessAt,
        nextPollAt: this.#nextPollAt,
        stale: this.#stale,
        staleRepositories: this.#published?.staleRepositories ?? [],
        pollInterval: this.#interval,
        rateLimits: this.#rateLimits,
      },
    };
  }

  /** Starts collecting now. */
  start(): void {
    if (this.#started || this.#stopped) {
      return;
    }
    this.#started = true;
    this.#schedule(this.#rateLimitWait());
  }

  /**
   * Collects as soon as possible, e.g. after a configuration change: now if idle, right after the
   * running collection otherwise, and never before a rate limit lifts.
   */
  pollNow(): void {
    if (!this.#started || this.#stopped) {
      return;
    }
    if (this.#running !== null) {
      this.#rerun = true;
      return;
    }
    this.#schedule(this.#rateLimitWait());
    this.#emit(null);
  }

  /**
   * Records a rate limit met outside a collection (by the page's edits of the watch list): no
   * collection starts before `retryAt`, in milliseconds since the epoch. A collection already
   * running is left alone: it meets the limit by itself, or shows that GitHub answers again.
   */
  holdUntil(retryAt: number): void {
    const now = this.#clock.now();
    if (this.#stopped || retryAt <= now || (this.#retryAt !== null && this.#retryAt >= retryAt)) {
      return;
    }
    this.#retryAt = retryAt;
    this.#rateLimits = { ...this.#rateLimits, retryAt: new Date(retryAt).toISOString() };
    const dueAt = this.#nextPollAt === null ? null : Date.parse(this.#nextPollAt);
    if (this.#started && this.#running === null && dueAt !== null && dueAt < retryAt) {
      this.#setInterval(this.#options.config(), retryAt - now, 'rate_limited');
      this.#schedule(retryAt - now);
    }
    this.#emit(null);
  }

  /** Stops the loop and aborts the running collection; resolves once it has ended. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#nextPollAt = null;
    this.#cancelTimer();
    this.#controller?.abort(new Error('The server is stopping.'));
    await this.#running;
  }

  #schedule(delayMs: number): void {
    this.#cancelTimer();
    const dueAt = this.#clock.now() + delayMs;
    this.#nextPollAt = new Date(dueAt).toISOString();
    this.#arm(dueAt);
  }

  /** Sets a timer for `dueAt`, in steps of at most {@link MAX_TIMER_MS}. */
  #arm(dueAt: number): void {
    const remaining = Math.max(0, dueAt - this.#clock.now());
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timer = null;
        // Checked against the clock rather than assumed: a capped timer covers part of the wait.
        if (this.#clock.now() < dueAt) {
          this.#arm(dueAt);
          return;
        }
        this.#rerun = false;
        this.#running = this.#run().finally(() => {
          this.#running = null;
        });
      },
      Math.min(remaining, MAX_TIMER_MS),
    );
  }

  #cancelTimer(): void {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #run(): Promise<void> {
    const config = this.#options.config();
    const controller = new AbortController();
    this.#controller = controller;
    let outcome: PollOutcome;
    let delayMs: number;
    try {
      const result = await this.#options.collect(config, controller.signal);
      // Aborted only by stop(): drop the result.
      if (controller.signal.aborted) {
        return;
      }
      ({ outcome, delayMs } = this.#succeeded(result, config));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      ({ outcome, delayMs } = this.#failed(error, config));
    } finally {
      this.#controller = null;
    }
    this.#schedule(this.#rerun ? this.#rateLimitWait() : delayMs);
    this.#emit(outcome);
  }

  #succeeded(result: CollectionResult, config: Config): { outcome: PollOutcome; delayMs: number } {
    const now = this.#clock.now();
    this.#published = carryOver(this.#published, result);
    this.#lastCheckedAt = this.#lastSuccessAt = new Date(now).toISOString();
    this.#stale = null;
    this.#failures = 0;
    this.#retryAt = result.retryAt?.getTime() ?? null;
    this.#rateLimits = {
      core: quotaView(result.rateLimits.core),
      search: quotaView(result.rateLimits.search),
      retryAt: result.retryAt?.toISOString() ?? null,
    };

    const core = result.rateLimits.core;
    const pacing = paceNextPoll({
      spent: result.requests.sent - result.requests.notModified,
      quota: core && {
        limit: core.limit,
        remaining: core.remaining,
        resetAt: core.resetAt.getTime(),
      },
      retryAt: this.#retryAt,
      baseIntervalMs: config.pollIntervalSeconds * 1000,
      now,
    });
    this.#setInterval(config, pacing.delayMs, pacing.reason);
    return {
      outcome: {
        kind: 'success',
        result,
        carried: this.#published.staleRepositories.length,
      },
      delayMs: pacing.delayMs,
    };
  }

  #failed(error: unknown, config: Config): { outcome: PollOutcome; delayMs: number } {
    const now = this.#clock.now();
    const nowIso = new Date(now).toISOString();
    this.#lastCheckedAt = nowIso;
    this.#failures += 1;
    const message = describeFailure(error);
    const base = config.pollIntervalSeconds * 1000;

    let delayMs: number;
    if (error instanceof RateLimitError) {
      this.#retryAt = error.retryAt.getTime();
      this.#rateLimits = { ...this.#rateLimits, retryAt: error.retryAt.toISOString() };
      delayMs = Math.max(base, this.#retryAt - now);
      this.#setInterval(config, delayMs, 'rate_limited');
    } else {
      delayMs = Math.min(base * 2 ** (this.#failures - 1), Math.max(base, MAX_BACKOFF_MS));
      this.#setInterval(config, delayMs, delayMs > base ? 'backoff' : 'base');
    }
    this.#stale = {
      reason: error instanceof RateLimitError ? 'rate_limited' : 'collection_failed',
      message,
      since: this.#stale?.since ?? nowIso,
    };
    return { outcome: { kind: 'failure', message, error, failures: this.#failures }, delayMs };
  }

  #setInterval(config: Config, delayMs: number, reason: PollInterval['reason']): void {
    this.#interval = {
      baseSeconds: config.pollIntervalSeconds,
      currentSeconds: Math.ceil(delayMs / 1000),
      reason,
    };
  }

  /** Milliseconds until the current rate limit lifts; 0 if there is none. */
  #rateLimitWait(): number {
    return this.#retryAt === null ? 0 : Math.max(0, this.#retryAt - this.#clock.now());
  }

  #emit(outcome: PollOutcome | null): void {
    this.#options.onUpdate(this.state, outcome);
  }
}

function quotaView(status: RateLimitStatus | null): Quota | null {
  return (
    status && {
      limit: status.limit,
      remaining: status.remaining,
      resetAt: status.resetAt.toISOString(),
    }
  );
}

/**
 * A short message for the page and the log. GitHub errors name the request and the status, never
 * a header; anything else is a bug, described generically (the log has the details).
 */
function describeFailure(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 401) {
      return 'GitHub rejected the token (401): it may have expired or been revoked. Restart with a valid token.';
    }
    return error.message;
  }
  return 'Unexpected error while collecting; see the server log.';
}
