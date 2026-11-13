import { describe, expect, it } from 'vitest';
import { NetworkError } from '../github/errors.ts';
import { CHANGE_LOG_MS, CollectionLog, QUIET_LOG_MS } from './collection-log.ts';
import type { PollOutcome, PollState } from './poller.ts';
import { collection, NOW, repo, snapshotOf } from './test-fixtures.ts';

const snapshot = snapshotOf([repo('octo-org/widgets', { active: true }), repo('octo-org/gadgets')]);

function state(
  reason: PollState['status']['pollInterval']['reason'] = 'base',
  seconds = 15,
): PollState {
  return {
    snapshot,
    status: {
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextPollAt: null,
      stale: null,
      staleRepositories: [],
      pollInterval: { baseSeconds: 15, currentSeconds: seconds, reason },
      rateLimits: {
        core: { limit: 5000, remaining: 4321, resetAt: '' },
        search: null,
        retryAt: null,
      },
    },
  };
}

const success: PollOutcome = {
  kind: 'success',
  result: collection(snapshot, {
    requests: { sent: 52, notModified: 50 },
    notRefreshed: ['octo-org/tools'],
  }),
  carried: 1,
};

describe('CollectionLog', () => {
  it('logs one line per collection worth reporting', () => {
    const lines: string[] = [];
    let now = NOW;
    const log = new CollectionLog(
      (line) => lines.push(line),
      () => now,
    );

    log.record(success, state(), true);
    expect(lines).toEqual([
      'Collected 2 repositories (1 active) · 52 requests, 50 not modified · quota 4321/5000 · 1 not refreshed · 1 shown from earlier data · next in 15s',
    ]);

    // Same outcome, content changing: at most once a minute.
    now += 15_000;
    log.record(success, state(), true);
    now += CHANGE_LOG_MS;
    log.record(success, state(), true);
    expect(lines).toHaveLength(2);

    // Nothing changes: once every quiet period.
    now += 15_000;
    log.record(success, state(), false);
    now += QUIET_LOG_MS;
    log.record(success, state(), false);
    expect(lines).toHaveLength(3);

    // A different pacing, a failure and a recovery are logged at once.
    now += 1;
    log.record(success, state('budget', 36), false);
    expect(lines.at(-1)).toMatch(/next in 36s \(budget\)$/);
    log.record(
      {
        kind: 'failure',
        message: 'GET /user: network error',
        error: new NetworkError('GET /user', false, null),
        failures: 2,
      },
      state('backoff', 30),
      false,
    );
    expect(lines.at(-1)).toBe(
      'Collection failed (2 in a row): GET /user: network error · next in 30s',
    );
    log.record(success, state(), false);
    expect(lines).toHaveLength(6);
  });

  it('adds the stack of unexpected errors', () => {
    const lines: string[] = [];
    new CollectionLog(
      (line) => lines.push(line),
      () => NOW,
    ).record(
      { kind: 'failure', message: 'Unexpected error', error: new TypeError('oops'), failures: 1 },
      state(),
      false,
    );
    expect(lines[0]).toMatch(/^Collection failed: Unexpected error · next in 15s\nTypeError: oops/);
  });
});
