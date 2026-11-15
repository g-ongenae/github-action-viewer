// Demo mode's stand-in for the poller and store: serves the synthetic payload of `payload.ts` to
// the real HTTP server, and moves its little story forward every half minute so that the page
// receives updates (and heartbeats in between).

import type { PayloadSource } from '../server/store.ts';
import type { Heartbeat, PagePayload } from '../server/payload.ts';
import { demoMaintained, demoPayload, type DemoVariant } from './payload.ts';
import { DemoWatchList } from './watch-list.ts';

/** Time between two steps of the demo story. */
const STEP_MS = 30_000;

export class DemoSource implements PayloadSource {
  readonly #variant: DemoVariant;
  readonly #start: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(changed: boolean) => void>();
  readonly #editable: boolean;
  /** The made-up editor of the watch list; its changes show on the page at once. */
  readonly watchList: DemoWatchList;
  #step = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  /** `editable`: whether the page may edit the watch list (false for `--read-only`). */
  constructor(variant: DemoVariant, now: () => number = Date.now, editable = true) {
    this.#variant = variant;
    this.#now = now;
    this.#start = now();
    this.#editable = editable;
    this.watchList = new DemoWatchList(demoMaintained(variant), () => {
      this.#notify(true);
    });
  }

  #payload(): PagePayload {
    return demoPayload(this.#variant, this.#start, this.#now(), this.#step, {
      maintained: this.watchList.maintained,
      editing: this.#editable ? 'on' : 'off',
    });
  }

  payloadJson(): string {
    return JSON.stringify(this.#payload());
  }

  heartbeat(): Heartbeat {
    const { status } = this.#payload();
    return {
      serverTime: new Date(this.#now()).toISOString(),
      lastCheckedAt: status.lastCheckedAt,
      lastSuccessAt: status.lastSuccessAt,
      nextPollAt: status.nextPollAt,
      pollInterval: status.pollInterval,
      rateLimits: status.rateLimits,
    };
  }

  subscribe(listener: (changed: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the story: a changed payload every {@link STEP_MS}. */
  start(): void {
    this.#timer = setInterval(() => {
      this.#step += 1;
      // Only the repositories change from one step to the next.
      this.#notify(this.#variant === 'full' || this.#variant === 'failing');
    }, STEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
    }
  }

  #notify(changed: boolean): void {
    for (const listener of this.#listeners) {
      listener(changed);
    }
  }
}
