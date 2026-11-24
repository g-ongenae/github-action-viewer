// The page's state: the latest payload, the latest heartbeat's fresher timestamps and quotas,
// the connection, the status filter and the lines marked as done. Every change re-renders
// (cheaply: see render.ts).

import type { LineView, RepositoryView } from '../core/snapshot.ts';
import type { Heartbeat, PagePayload } from '../server/payload.ts';
import type { ConnectionState } from './connection.ts';
import { DoneLines, lineId, localStorageOf, withoutDone } from './done.ts';
import { FilterBar } from './filter-bar.ts';
import { countStatuses, describeFilter } from './filter.ts';
import { PageRenderer } from './render.ts';
import { RepositoryDialog } from './repository-dialog.ts';
import { describeChanges } from './summary.ts';
import { createWatchListApi, type WatchListApi } from './watch-list-api.ts';

export class App {
  readonly #renderer: PageRenderer;
  readonly #dialog: RepositoryDialog;
  readonly #filterBar: FilterBar;
  readonly #done: DoneLines;
  readonly #document: Document;
  readonly #now: () => number;
  #payload: PagePayload | null = null;
  #connection: ConnectionState = 'connecting';
  #wasLive = false;

  constructor(
    document: Document,
    now: () => number = Date.now,
    api: WatchListApi = createWatchListApi(),
    storage: Storage | null = localStorageOf(document.defaultView),
  ) {
    this.#done = new DoneLines(storage);
    this.#renderer = new PageRenderer(document, {
      onDone: (id, done) => {
        this.#setDone(id, done);
      },
      onFocusLost: () => {
        this.#filterBar.focusDone();
      },
    });
    const opener = document.getElementById('add-repository');
    if (!(opener instanceof HTMLButtonElement)) {
      throw new Error('The page has no #add-repository button.');
    }
    this.#dialog = new RepositoryDialog(document, opener, api);
    this.#filterBar = new FilterBar(document, () => {
      this.render();
      this.#renderer.announce(
        describeFilter(this.#visible().repositories, this.#filterBar.selected),
      );
    });
    // Another tab marked a line as done, or not done.
    document.defaultView?.addEventListener('storage', (event) => {
      if (this.#done.concerns(event)) {
        this.#done.reload();
        this.render();
      }
    });
    this.#document = document;
    this.#now = now;
    this.render();
  }

  /** A new payload: the page's content changed (or the stream was just opened). */
  setPayload(payload: PagePayload): void {
    const previous = this.#payload?.snapshot ?? null;
    this.#payload = payload;
    if (payload.snapshot !== null) {
      this.#done.prune(payload.snapshot);
    }
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
    const focused = this.#document.activeElement;
    const { repositories, done } = this.#visible();
    const empty = (this.#payload?.snapshot?.repositories.length ?? 0) === 0;
    this.#filterBar.update(empty ? null : countStatuses(repositories), done.size);
    this.#renderer.render({
      payload: this.#payload,
      connection: this.#connection,
      now: this.#now(),
      filter: this.#filterBar.selected,
      done,
      showDone: this.#filterBar.showDone,
    });
    // A line that stopped matching or was marked as done in another tab took the focus with it,
    // or “Include done” went away: keep the reader near the lines.
    if (
      focused instanceof HTMLElement &&
      (!focused.isConnected || focused.closest('[hidden]') !== null)
    ) {
      this.#filterBar.takeFocus();
    }
  }

  /** The lines the status filter applies to, and the ids of the lines marked as done. */
  #visible(): { repositories: readonly RepositoryView[]; done: ReadonlySet<string> } {
    const all = this.#payload?.snapshot?.repositories ?? [];
    const done = this.#done.doneIn(all);
    return { repositories: this.#filterBar.showDone ? all : withoutDone(all, done), done };
  }

  #setDone(id: string, done: boolean): void {
    const found = this.#find(id);
    if (found === null) {
      return;
    }
    const { repository, line, seenAt } = found;
    if (done) {
      this.#done.mark(repository, line, seenAt);
    } else {
      this.#done.unmark(repository, line);
    }
    this.render();
    const name = `${repository.fullName} ${line.label}`;
    this.#renderer.announce(done ? `${name} marked as done.` : `${name} no longer done.`);
  }

  #find(id: string): { repository: RepositoryView; line: LineView; seenAt: string } | null {
    const snapshot = this.#payload?.snapshot ?? null;
    for (const repository of snapshot?.repositories ?? []) {
      const line = repository.lines.find((candidate) => lineId(repository, candidate) === id);
      if (snapshot !== null && line !== undefined) {
        return { repository, line, seenAt: snapshot.generatedAt };
      }
    }
    return null;
  }
}
