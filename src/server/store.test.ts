import { describe, expect, it } from 'vitest';
import type { ConfigStatus } from './payload.ts';
import type { PollState } from './poller.ts';
import { PayloadStore } from './store.ts';
import { NOW, repo, snapshotOf } from './test-fixtures.ts';

const OK: ConfigStatus = {
  state: 'ok',
  problems: null,
  fallback: null,
  maintainedRepositories: [],
  editing: 'on',
};
const INVALID: ConfigStatus = {
  ...OK,
  state: 'invalid',
  problems: 'port: wrong',
  fallback: 'last_valid',
  editing: 'blocked',
};

function pollState(
  at: number,
  overrides: Partial<PollState['status']> = {},
  active = false,
): PollState {
  const iso = new Date(at).toISOString();
  return {
    snapshot: {
      ...snapshotOf([repo('octo-org/widgets', { active })], at),
      rateLimit: { limit: 5000, remaining: 5000 - at / 1000, resetAt: iso },
    },
    status: {
      lastCheckedAt: iso,
      lastSuccessAt: iso,
      nextPollAt: new Date(at + 15_000).toISOString(),
      stale: null,
      staleRepositories: [],
      pollInterval: { baseSeconds: 15, currentSeconds: 15 + (at % 7), reason: 'base' },
      rateLimits: {
        core: null,
        search: { limit: 30, remaining: at % 30, resetAt: iso },
        retryAt: null,
      },
      ...overrides,
    },
  };
}

describe('PayloadStore', () => {
  it('assembles the payload and serves it as JSON', () => {
    const store = new PayloadStore(pollState(NOW), OK);
    expect(store.payload.status.config).toBe(OK);
    expect(JSON.parse(store.payloadJson())).toEqual(store.payload);
  });

  it('ignores timestamps, quotas and the interval when detecting changes', () => {
    const store = new PayloadStore(pollState(NOW), OK);
    const seen: boolean[] = [];
    store.subscribe((changed) => seen.push(changed));

    expect(store.setPollState(pollState(NOW + 15_000))).toBe(false);
    // The JSON is still the latest, timestamps included.
    expect(store.payload.status.lastCheckedAt).toBe(new Date(NOW + 15_000).toISOString());
    expect(store.setPollState(pollState(NOW + 30_000, {}, true))).toBe(true);
    expect(
      store.setPollState(
        pollState(
          NOW + 45_000,
          {
            stale: {
              reason: 'collection_failed',
              message: 'down',
              since: new Date(NOW).toISOString(),
            },
          },
          true,
        ),
      ),
    ).toBe(true);
    expect(store.setConfigStatus(INVALID)).toBe(true);
    expect(store.setConfigStatus(INVALID)).toBe(false);
    expect(seen).toEqual([false, true, true, true, false]);
  });

  it('puts the per-collection fields in heartbeats', () => {
    const state = pollState(NOW);
    const store = new PayloadStore(state, OK, () => NOW + 5);
    expect(store.heartbeat()).toEqual({
      serverTime: new Date(NOW + 5).toISOString(),
      lastCheckedAt: state.status.lastCheckedAt,
      lastSuccessAt: state.status.lastSuccessAt,
      nextPollAt: state.status.nextPollAt,
      pollInterval: state.status.pollInterval,
      rateLimits: state.status.rateLimits,
    });
  });

  it('stops notifying after unsubscribe', () => {
    const store = new PayloadStore(pollState(NOW), OK);
    let calls = 0;
    const unsubscribe = store.subscribe(() => (calls += 1));
    store.setPollState(pollState(NOW + 1));
    unsubscribe();
    store.setPollState(pollState(NOW + 2));
    expect(calls).toBe(1);
  });
});
