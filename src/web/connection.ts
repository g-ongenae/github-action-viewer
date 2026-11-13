// The live connection to the server: an EventSource on `/api/events`, plus a watchdog. The
// server sends a heartbeat at least every 15 seconds, so a stream that stays silent much longer
// is treated as lost even if the socket looks open (a suspended laptop, a stuck proxy), and is
// reopened.

import type { EventName, Heartbeat, PagePayload } from '../server/payload.ts';

/**
 * - `connecting`: no message yet since the page loaded;
 * - `live`: a message arrived recently;
 * - `reconnecting`: the stream was lost a moment ago and is being reopened;
 * - `disconnected`: no message for a while (still retrying in the background).
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

/** The part of `EventSource` used here, so that tests can provide their own. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

/** `EventSource.CLOSED`: the browser gave up and will not reconnect by itself. */
const CLOSED = 2;

/** No message for this long: the stream is considered dead (three missed heartbeats). */
export const SILENCE_MS = 45_000;

/** Lost for this long: `reconnecting` becomes `disconnected`. */
export const DISCONNECTED_AFTER_MS = 20_000;

/** Delay before reopening a stream the browser closed for good (e.g. a 503 answer). */
export const REOPEN_DELAY_MS = 5_000;

export interface ConnectionOptions {
  readonly url: string;
  readonly onPayload: (payload: PagePayload) => void;
  readonly onHeartbeat: (heartbeat: Heartbeat) => void;
  readonly onStateChange: (state: ConnectionState) => void;
  readonly createSource?: (url: string) => EventSourceLike;
}

export class Connection {
  readonly #options: ConnectionOptions;
  #source: EventSourceLike | null = null;
  #state: ConnectionState = 'connecting';
  #everLive = false;
  #lost = false;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reopenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    this.#open();
    this.#armWatchdog();
    // Never connecting at all is a loss too: it turns into `disconnected` in time.
    this.#markLost();
  }

  stop(): void {
    this.#source?.close();
    this.#source = null;
    for (const timer of [this.#silenceTimer, this.#disconnectTimer, this.#reopenTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.#silenceTimer = this.#disconnectTimer = this.#reopenTimer = null;
  }

  #open(): void {
    const create = this.#options.createSource ?? ((url: string) => new EventSource(url));
    const source = create(this.#options.url);
    this.#source = source;
    const listen = (name: EventName, handle: (data: unknown) => void): void => {
      source.addEventListener(name, (event) => {
        if (source !== this.#source) {
          return;
        }
        const data = parse(event);
        if (data !== undefined) {
          this.#markAlive();
          handle(data);
        }
      });
    };
    listen('payload', (data) => {
      this.#options.onPayload(data as PagePayload);
    });
    listen('heartbeat', (data) => {
      this.#options.onHeartbeat(data as Heartbeat);
    });
    source.addEventListener('error', () => {
      if (source !== this.#source) {
        return;
      }
      this.#markLost();
      if (source.readyState === CLOSED) {
        this.#reopenLater();
      }
    });
  }

  #reopenLater(): void {
    if (this.#reopenTimer !== null) {
      return;
    }
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = null;
      this.#source?.close();
      this.#open();
    }, REOPEN_DELAY_MS);
  }

  #markAlive(): void {
    this.#everLive = true;
    this.#lost = false;
    if (this.#disconnectTimer !== null) {
      clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = null;
    }
    this.#armWatchdog();
    this.#setState('live');
  }

  /**
   * Restarts the silence countdown. When it runs out, the stream is closed and reopened, even
   * if the socket still looks open; the countdown then starts again, so a stream that never
   * answers is retried too.
   */
  #armWatchdog(): void {
    if (this.#silenceTimer !== null) {
      clearTimeout(this.#silenceTimer);
    }
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      this.#markLost();
      this.#source?.close();
      this.#open();
      this.#armWatchdog();
    }, SILENCE_MS);
  }

  #markLost(): void {
    if (this.#lost) {
      return;
    }
    this.#lost = true;
    this.#setState(this.#everLive ? 'reconnecting' : 'connecting');
    this.#disconnectTimer = setTimeout(() => {
      this.#disconnectTimer = null;
      this.#setState('disconnected');
    }, DISCONNECTED_AFTER_MS);
  }

  #setState(state: ConnectionState): void {
    if (state !== this.#state) {
      this.#state = state;
      this.#options.onStateChange(state);
    }
  }
}

/** The JSON data of a server-sent event; undefined if it is not valid JSON. */
function parse(event: Event): unknown {
  const data: unknown = (event as MessageEvent<unknown>).data;
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}
