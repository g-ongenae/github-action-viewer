import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../core/config.ts';
import type { CollectionResult } from '../github/collect.ts';
import { AccessDeniedError, NetworkError, RateLimitError } from '../github/errors.ts';
import { MAX_BACKOFF_MS, Poller, systemClock, type PollOutcome, type PollState } from './poller.ts';
import { collection, names, NOW, repo, snapshotOf } from './test-fixtures.ts';

const BASE = DEFAULT_CONFIG.pollIntervalSeconds * 1000;

/** A collect function answering from a script; each call waits for the test to resolve it. */
class ScriptedCollect {
  readonly calls: {
    config: Config;
    signal: AbortSignal;
    resolve: (r: CollectionResult) => void;
    reject: (e: unknown) => void;
  }[] = [];

  readonly collect = (config: Config, signal: AbortSignal): Promise<CollectionResult> =>
    new Promise((resolve, reject) => {
      this.calls.push({ config, signal, resolve, reject });
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
    });

  /** Settles the latest call and lets the poller handle it. */
  async succeed(result: CollectionResult): Promise<void> {
    this.#last().resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  }

  async fail(error: unknown): Promise<void> {
    this.#last().reject(error);
    await vi.advanceTimersByTimeAsync(0);
  }

  #last() {
    const call = this.calls.at(-1);
    if (call === undefined) {
      throw new Error('collect was not called');
    }
    return call;
  }
}

let script: ScriptedCollect;
let updates: { state: PollState; outcome: PollOutcome | null }[];
let config: Config;

function poller(): Poller {
  return new Poller({
    collect: script.collect,
    config: () => config,
    onUpdate: (state, outcome) => updates.push({ state, outcome }),
    clock: systemClock,
  });
}

function lastState(): PollState {
  const update = updates.at(-1);
  if (update === undefined) {
    throw new Error('no update');
  }
  return update.state;
}

const quiet = (at = Date.now()) =>
  collection(snapshotOf([repo('octo-org/widgets'), repo('octo-org/gadgets')], at), {
    requests: { sent: 10, notModified: 10 },
    rateLimits: {
      core: {
        resource: 'core',
        limit: 5000,
        remaining: 4000,
        used: 1000,
        resetAt: new Date(at + 3_600_000),
      },
      search: null,
    },
  });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  script = new ScriptedCollect();
  updates = [];
  config = DEFAULT_CONFIG;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Poller', () => {
  it('collects at once, then every interval, never overlapping', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(script.calls).toHaveLength(1);

    // The collection takes three intervals: nothing else starts meanwhile.
    await vi.advanceTimersByTimeAsync(3 * BASE);
    expect(script.calls).toHaveLength(1);
    await script.succeed(quiet());
    expect(lastState().status.nextPollAt).toBe(new Date(Date.now() + BASE).toISOString());

    await vi.advanceTimersByTimeAsync(BASE - 1);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(2);
    await p.stop();
  });

  it('publishes the snapshot and the server status', async () => {
    const p = poller();
    expect(p.state.snapshot).toBeNull();
    p.start();
    await vi.advanceTimersByTimeAsync(1000);
    await script.succeed(quiet(NOW));

    const { snapshot, status } = lastState();
    expect(names(snapshot)).toEqual(['octo-org/gadgets', 'octo-org/widgets']);
    expect(status).toEqual({
      lastCheckedAt: new Date(NOW + 1000).toISOString(),
      lastSuccessAt: new Date(NOW + 1000).toISOString(),
      nextPollAt: new Date(NOW + 1000 + BASE).toISOString(),
      stale: null,
      staleRepositories: [],
      pollInterval: { baseSeconds: 15, currentSeconds: 15, reason: 'base' },
      rateLimits: {
        core: { limit: 5000, remaining: 4000, resetAt: new Date(NOW + 3_600_000).toISOString() },
        search: null,
        retryAt: null,
      },
    });
    expect(updates.at(-1)?.outcome).toMatchObject({ kind: 'success', carried: 0 });
    await p.stop();
  });

  it('stretches the interval when the spending would exhaust the quota', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const busy = quiet();
    // 30 counted requests per poll, 3,000 left above the reserve, one hour to go: 36 s.
    await script.succeed({ ...busy, requests: { sent: 40, notModified: 10 } });
    expect(lastState().status.pollInterval).toEqual({
      baseSeconds: 15,
      currentSeconds: 36,
      reason: 'budget',
    });

    await vi.advanceTimersByTimeAsync(35_999);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(2);

    // Activity drops: back to the base interval.
    await script.succeed(quiet());
    expect(lastState().status.pollInterval.reason).toBe('base');
    await p.stop();
  });

  it('waits for retryAt and carries over the repositories it could not refresh', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await script.succeed(quiet());

    await vi.advanceTimersByTimeAsync(BASE);
    const retryAt = new Date(Date.now() + 10 * 60_000);
    await script.succeed(
      collection(snapshotOf([repo('octo-org/widgets')], Date.now()), {
        retryAt,
        notRefreshed: ['octo-org/gadgets'],
      }),
    );
    const { snapshot, status } = lastState();
    expect(names(snapshot)).toEqual(['octo-org/gadgets', 'octo-org/widgets']);
    expect(status.staleRepositories).toEqual([
      { fullName: 'octo-org/gadgets', lastRefreshedAt: new Date(NOW).toISOString() },
    ]);
    expect(status.pollInterval).toEqual({
      baseSeconds: 15,
      currentSeconds: 600,
      reason: 'rate_limited',
    });
    expect(status.rateLimits.retryAt).toBe(retryAt.toISOString());

    // A configuration change does not jump the queue.
    p.pollNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(script.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(3);
    await p.stop();
  });

  it('keeps the last good snapshot, stale, while collections fail, and recovers', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await script.succeed(quiet(NOW));
    const good = lastState().snapshot;

    await vi.advanceTimersByTimeAsync(BASE);
    const firstFailure = new Date(Date.now()).toISOString();
    await script.fail(new NetworkError('GET /user/repos', false, 'ECONNREFUSED'));
    expect(lastState().snapshot).toBe(good);
    expect(lastState().status.stale).toEqual({
      reason: 'collection_failed',
      message: 'GET /user/repos: network error (ECONNREFUSED)',
      since: firstFailure,
    });
    expect(lastState().status.lastSuccessAt).toBe(new Date(NOW).toISOString());
    expect(lastState().status.pollInterval).toEqual({
      baseSeconds: 15,
      currentSeconds: 15,
      reason: 'base',
    });

    // Backs off: 30 s after the second failure, 60 s after the third.
    await vi.advanceTimersByTimeAsync(BASE);
    await script.fail(new AccessDeniedError('GET /user', 401, '401 Unauthorized'));
    expect(lastState().status.pollInterval).toEqual({
      baseSeconds: 15,
      currentSeconds: 30,
      reason: 'backoff',
    });
    expect(lastState().status.stale?.since).toBe(firstFailure);
    expect(lastState().status.stale?.message).toMatch(/rejected the token/);
    await vi.advanceTimersByTimeAsync(30_000);
    await script.fail(new Error('boom'));
    expect(lastState().status.stale?.message).toBe(
      'Unexpected error while collecting; see the server log.',
    );
    expect(updates.at(-1)?.outcome).toMatchObject({ kind: 'failure', failures: 3 });
    expect(lastState().status.pollInterval.currentSeconds).toBe(60);

    await vi.advanceTimersByTimeAsync(60_000);
    await script.succeed(quiet());
    expect(lastState().status.stale).toBeNull();
    expect(lastState().status.lastSuccessAt).toBe(new Date(Date.now()).toISOString());
    expect(lastState().status.pollInterval.reason).toBe('base');
    await p.stop();
  });

  it('caps the backoff', async () => {
    const p = poller();
    p.start();
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
      await script.fail(new NetworkError('GET /user', true, null));
    }
    expect(lastState().status.pollInterval.currentSeconds).toBe(MAX_BACKOFF_MS / 1000);
    await p.stop();
  });

  it('waits for a rate limit that fails the whole collection', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const retryAt = new Date(Date.now() + 120_000);
    await script.fail(new RateLimitError('GET /user', 403, 'primary', 'core', retryAt));
    expect(lastState().status.stale?.reason).toBe('rate_limited');
    expect(lastState().status.rateLimits.retryAt).toBe(retryAt.toISOString());
    expect(lastState().status.nextPollAt).toBe(retryAt.toISOString());
    await p.stop();
  });

  it('holds the next collection for a rate limit met outside a collection', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await script.succeed(quiet());
    const retryAt = Date.now() + 10 * 60_000;

    p.holdUntil(retryAt);

    const { status } = lastState();
    expect(status.rateLimits.retryAt).toBe(new Date(retryAt).toISOString());
    expect(status.nextPollAt).toBe(new Date(retryAt).toISOString());
    expect(status.pollInterval).toEqual({
      baseSeconds: 15,
      currentSeconds: 600,
      reason: 'rate_limited',
    });
    // Neither the interval nor an urgent request starts a collection before the limit lifts.
    p.pollNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(2);

    await script.succeed(quiet());
    expect(lastState().status.rateLimits.retryAt).toBeNull();
    expect(lastState().status.pollInterval.reason).toBe('base');
  });

  it('ignores a hold that is over, or shorter than the one in effect', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    await script.succeed(quiet());
    const retryAt = Date.now() + 60_000;
    p.holdUntil(retryAt);
    const published = updates.length;

    p.holdUntil(Date.now() - 1);
    p.holdUntil(retryAt - 30_000);

    expect(updates).toHaveLength(published);
    expect(lastState().status.rateLimits.retryAt).toBe(new Date(retryAt).toISOString());
  });

  it('leaves a running collection alone when a hold arrives, and starts held', async () => {
    const p = poller();
    p.holdUntil(Date.now() + 60_000);
    p.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(script.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(1);

    // GitHub answering the running collection is the fresher news: the hold goes with it.
    p.holdUntil(Date.now() + 60_000);
    expect(script.calls[0]?.signal.aborted).toBe(false);
    await script.succeed(quiet());
    expect(lastState().status.rateLimits.retryAt).toBeNull();
    expect(lastState().status.nextPollAt).toBe(new Date(Date.now() + BASE).toISOString());
  });

  it('waits past the 2^31 ms timer limit instead of firing at once', async () => {
    const delays: number[] = [];
    const p = new Poller({
      collect: script.collect,
      config: () => config,
      onUpdate: (state, outcome) => updates.push({ state, outcome }),
      clock: {
        ...systemClock,
        setTimeout: (callback, ms) => {
          delays.push(ms);
          return systemClock.setTimeout(callback, ms);
        },
      },
    });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    // A rate limit lifting in 30 days: well past what setTimeout can hold (2^31 − 1 ms).
    const waitMs = 2 ** 31 + 30 * 86_400_000;
    const retryAt = new Date(Date.now() + waitMs);
    await script.fail(new RateLimitError('GET /user', 403, 'primary', 'core', retryAt));
    expect(lastState().status.nextPollAt).toBe(retryAt.toISOString());

    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(waitMs - 2 ** 31 - 1);
    expect(script.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls).toHaveLength(2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
    await p.stop();
  });

  it('collects right after the running collection when asked meanwhile, with the new config', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    config = { ...DEFAULT_CONFIG, pollIntervalSeconds: 60 };
    p.pollNow();
    expect(script.calls).toHaveLength(1);
    await script.succeed(quiet());
    await vi.advanceTimersByTimeAsync(0);
    expect(script.calls).toHaveLength(2);
    expect(script.calls[1]?.config.pollIntervalSeconds).toBe(60);

    await script.succeed(quiet());
    expect(lastState().status.pollInterval.baseSeconds).toBe(60);
    // When idle, it collects at once.
    p.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(script.calls).toHaveLength(3);
    await p.stop();
  });

  it('aborts the running collection on stop and publishes nothing more', async () => {
    const p = poller();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    const count = updates.length;
    await p.stop();
    expect(script.calls[0]?.signal.aborted).toBe(true);
    expect(updates).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(10 * BASE);
    expect(script.calls).toHaveLength(1);
    p.pollNow();
    p.start();
    await vi.advanceTimersByTimeAsync(BASE);
    expect(script.calls).toHaveLength(1);
  });
});
