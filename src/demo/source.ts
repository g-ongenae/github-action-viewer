// Demo mode's stand-in for the poller and store: serves the synthetic payload of `payload.ts` to
// the real HTTP server, and moves its little story forward every half minute so that the page
// receives updates (and heartbeats in between).

import type { PayloadSource } from '../server/store.ts';
import type { Heartbeat, PagePayload } from '../server/payload.ts';
import { demoPayload, type DemoVariant } from './payload.ts';

/** Time between two steps of the demo story. */
const STEP_MS = 30_000;

export class DemoSource implements PayloadSource {
  readonly #variant: DemoVariant;
  readonly #start: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(changed: boolean) => void>();
  #step = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(variant: DemoVariant, now: () => number = Date.now) {
    this.#variant = variant;
    this.#now = now;
    this.#start = now();
  }

  #payload(): PagePayload {
    return demoPayload(this.#variant, this.#start, this.#now(), this.#step);
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
      const changed = this.#variant === 'full' || this.#variant === 'failing';
      for (const listener of this.#listeners) {
        listener(changed);
      }
    }, STEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
    }
  }
}
