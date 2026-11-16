// The page's state: the latest payload, the latest heartbeat's fresher timestamps and quotas,
// and the connection. Every change re-renders (cheaply: see render.ts).

import type { Heartbeat, PagePayload } from '../server/payload.ts';
import type { ConnectionState } from './connection.ts';
import { PageRenderer } from './render.ts';
import { RepositoryDialog } from './repository-dialog.ts';
import { describeChanges } from './summary.ts';
import { createWatchListApi, type WatchListApi } from './watch-list-api.ts';

export class App {
  readonly #renderer: PageRenderer;
  readonly #dialog: RepositoryDialog;
  readonly #now: () => number;
  #payload: PagePayload | null = null;
  #connection: ConnectionState = 'connecting';
  #wasLive = false;

  constructor(
    document: Document,
    now: () => number = Date.now,
    api: WatchListApi = createWatchListApi(),
  ) {
    this.#renderer = new PageRenderer(document);
    const opener = document.getElementById('add-repository');
    if (!(opener instanceof HTMLButtonElement)) {
      throw new Error('The page has no #add-repository button.');
    }
    this.#dialog = new RepositoryDialog(document, opener, api);
    this.#now = now;
    this.render();
  }

  /** A new payload: the page's content changed (or the stream was just opened). */
  setPayload(payload: PagePayload): void {
    const previous = this.#payload?.snapshot ?? null;
    this.#payload = payload;
    this.render();
    this.#dialog.update({
      config: payload.status.config,
      repositories: payload.snapshot?.repositories ?? [],
    });
    this.#renderer.announce(describeChanges(previous, payload.snapshot));
  }

  /**
   * A heartbeat: nothing changed but the fields that change on every collection (when data was
   * last checked, the next poll, the interval and quotas), which it carries.
   */
  applyHeartbeat(heartbeat: Heartbeat): void {
    if (this.#payload === null) {
      return;
    }
    const { lastCheckedAt, lastSuccessAt, nextPollAt, pollInterval, rateLimits } = heartbeat;
    this.#payload = {
      ...this.#payload,
      status: {
        ...this.#payload.status,
        lastCheckedAt,
        lastSuccessAt,
        nextPollAt,
        pollInterval,
        rateLimits,
      },
    };
    this.render();
  }

  setConnection(state: ConnectionState): void {
    if (state === this.#connection) {
      return;
    }
    const previous = this.#connection;
    this.#connection = state;
    this.render();
    if (state === 'live' && this.#wasLive && previous !== 'live') {
      this.#renderer.announce('Reconnected.');
    } else if (state === 'disconnected' && this.#wasLive) {
      this.#renderer.announce('Connection to the viewer lost; retrying.');
    }
    this.#wasLive ||= state === 'live';
  }

  /** Re-renders with the current time, so that relative times keep ticking. */
  render(): void {
    this.#renderer.render({
      payload: this.#payload,
      connection: this.#connection,
      now: this.#now(),
    });
  }
}
