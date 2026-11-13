import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Connection,
  DISCONNECTED_AFTER_MS,
  REOPEN_DELAY_MS,
  SILENCE_MS,
  type ConnectionState,
  type EventSourceLike,
} from './connection.ts';
import { heartbeat, payload } from './test-fixtures.ts';

/** A scripted EventSource: tests emit events on it. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  readonly #listeners = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown): void {
    this.readyState = type === 'error' ? this.readyState : 1;
    const event = {
      type,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as unknown as Event;
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function setup() {
  const sources: FakeSource[] = [];
  const states: ConnectionState[] = [];
  const onPayload = vi.fn();
  const onHeartbeat = vi.fn();
  const connection = new Connection({
    url: '/api/events',
    onPayload,
    onHeartbeat,
    onStateChange: (state) => states.push(state),
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  });
  connection.start();
  const latest = (): FakeSource => {
    const source = sources.at(-1);
    if (source === undefined) {
      throw new Error('no source');
    }
    return source;
  };
  return { connection, sources, states, onPayload, onHeartbeat, latest };
}

describe('Connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is connecting, then live on the first payload, which it hands over', () => {
    const { connection, latest, onPayload } = setup();
    expect(connection.state).toBe('connecting');
    const sent = payload([]);
    latest().emit('payload', sent);
    expect(connection.state).toBe('live');
    expect(onPayload).toHaveBeenCalledWith(sent);
  });

  it('hands heartbeats over and ignores data that is not JSON', () => {
    const { latest, onHeartbeat, onPayload } = setup();
    latest().emit('heartbeat', heartbeat());
    latest().emit('payload', '{not json');
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('turns disconnected when the server never answers', () => {
    const { connection } = setup();
    vi.advanceTimersByTime(DISCONNECTED_AFTER_MS);
    expect(connection.state).toBe('disconnected');
  });

  it('treats a silent stream as lost even if the socket looks open, and reopens it', () => {
    const { connection, sources, latest, states } = setup();
    latest().emit('payload', payload([]));
    vi.advanceTimersByTime(SILENCE_MS - 1);
    latest().emit('heartbeat', heartbeat());
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(connection.state).toBe('live');
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(connection.state).toBe('reconnecting');
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(2);

    vi.advanceTimersByTime(DISCONNECTED_AFTER_MS);
    expect(connection.state).toBe('disconnected');

    latest().emit('payload', payload([]));
    expect(connection.state).toBe('live');
    expect(states).toEqual(['live', 'reconnecting', 'disconnected', 'live']);
  });

  it('reconnects through the browser after an error, ignoring the old stream', () => {
    const { connection, latest, onHeartbeat } = setup();
    const first = latest();
    first.emit('payload', payload([]));
    first.emit('error');
    expect(connection.state).toBe('reconnecting');
    // The browser retries on the same EventSource.
    first.emit('payload', payload([]));
    expect(connection.state).toBe('live');

    // A stream replaced after silence no longer counts.
    vi.advanceTimersByTime(SILENCE_MS);
    first.emit('heartbeat', heartbeat());
    expect(onHeartbeat).not.toHaveBeenCalled();
  });

  it('reopens a stream the browser closed for good', () => {
    const { sources, latest } = setup();
    const first = latest();
    first.readyState = 2;
    first.emit('error');
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(REOPEN_DELAY_MS);
    expect(sources).toHaveLength(2);
  });

  it('stops everything', () => {
    const { connection, sources, latest } = setup();
    connection.stop();
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(10 * SILENCE_MS);
    expect(sources).toHaveLength(1);
  });
});
