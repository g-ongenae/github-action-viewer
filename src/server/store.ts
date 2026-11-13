import type { ConfigStatus, Heartbeat, PagePayload } from './payload.ts';
import type { PollState } from './poller.ts';

/** What the HTTP server reads: the current payload, and notifications when it may have changed. */
export interface PayloadSource {
  /** The current payload, as JSON. */
  payloadJson(): string;
  heartbeat(): Heartbeat;
  /**
   * Calls `listener` after every update: `changed` tells whether the payload's content changed,
   * or only its timestamps and quotas. Returns the unsubscribe function.
   */
  subscribe(listener: (changed: boolean) => void): () => void;
}

/**
 * Holds the payload, assembled from the poller's state and the configuration status, and tells
 * subscribers what changed.
 *
 * Every collection refreshes timestamps (`generatedAt`, `lastCheckedAt`, `nextPollAt`…), quota
 * counters and the stretched poll interval, even when nothing else changed; these are left out of the change detection and sent
 * in heartbeats instead, so the page only re-renders on real changes.
 */
export class PayloadStore implements PayloadSource {
  readonly #now: () => number;
  #poll: PollState;
  #config: ConfigStatus;
  #json = '';
  #contentKey = '';
  readonly #listeners = new Set<(changed: boolean) => void>();

  constructor(poll: PollState, config: ConfigStatus, now: () => number = Date.now) {
    this.#poll = poll;
    this.#config = config;
    this.#now = now;
    this.#rebuild();
  }

  get payload(): PagePayload {
    return {
      snapshot: this.#poll.snapshot,
      status: { ...this.#poll.status, config: this.#config },
    };
  }

  /** Records the poller's new state; returns whether the content changed. */
  setPollState(poll: PollState): boolean {
    this.#poll = poll;
    return this.#update();
  }

  /** Records the configuration's new status; returns whether the content changed. */
  setConfigStatus(config: ConfigStatus): boolean {
    this.#config = config;
    return this.#update();
  }

  payloadJson(): string {
    return this.#json;
  }

  heartbeat(): Heartbeat {
    const { lastCheckedAt, lastSuccessAt, nextPollAt, pollInterval, rateLimits } =
      this.#poll.status;
    return {
      serverTime: new Date(this.#now()).toISOString(),
      lastCheckedAt,
      lastSuccessAt,
      nextPollAt,
      pollInterval,
      rateLimits,
    };
  }

  subscribe(listener: (changed: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #update(): boolean {
    const changed = this.#rebuild();
    for (const listener of this.#listeners) {
      listener(changed);
    }
    return changed;
  }

  #rebuild(): boolean {
    const payload = this.payload;
    this.#json = JSON.stringify(payload);
    const key = contentKey(payload);
    const changed = key !== this.#contentKey;
    this.#contentKey = key;
    return changed;
  }
}

/** The payload without the fields that change on every collection (see {@link PayloadStore}). */
export function contentKey(payload: PagePayload): string {
  const { snapshot, status } = payload;
  return JSON.stringify({
    snapshot: snapshot && { ...snapshot, generatedAt: null, rateLimit: null },
    status: {
      ...status,
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextPollAt: null,
      pollInterval: null,
      rateLimits: null,
    },
  });
}
