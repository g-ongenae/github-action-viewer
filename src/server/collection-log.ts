import { GitHubError } from '../github/errors.ts';
import type { Log } from './log.ts';
import type { PollOutcome, PollState } from './poller.ts';

/** Longest silence while nothing changes: one line every so often shows the server is alive. */
export const QUIET_LOG_MS = 10 * 60_000;

/** Shortest gap between two lines reporting only that the page's content changed. */
export const CHANGE_LOG_MS = 60_000;

/**
 * Logs collections without flooding the terminal: a line at once when the outcome changes (a
 * failure, a recovery, a different pacing), at most one a minute while the page's content keeps
 * changing (runs in progress), and one every {@link QUIET_LOG_MS} otherwise.
 */
export class CollectionLog {
  readonly #log: Log;
  readonly #now: () => number;
  #lastLineAt = Number.NEGATIVE_INFINITY;
  #lastSummary = '';

  constructor(log: Log, now: () => number = Date.now) {
    this.#log = log;
    this.#now = now;
  }

  record(outcome: PollOutcome, state: PollState, changed: boolean): void {
    const { pollInterval, rateLimits } = state.status;
    const next = `next in ${String(pollInterval.currentSeconds)}s`;
    let line: string;
    // What decides whether the line is worth printing; counts and quotas are left out.
    let summary: string;

    if (outcome.kind === 'failure') {
      line = `Collection failed${outcome.failures > 1 ? ` (${String(outcome.failures)} in a row)` : ''}: ${outcome.message} · ${next}`;
      summary = `failure:${outcome.message}`;
      if (!(outcome.error instanceof GitHubError) && outcome.error instanceof Error) {
        line += `\n${outcome.error.stack ?? outcome.error.message}`;
      }
    } else {
      const { requests, notRefreshed } = outcome.result;
      const repositories = state.snapshot?.repositories ?? [];
      const active = repositories.filter((repository) => repository.active).length;
      const core = rateLimits.core;
      const parts = [
        `${String(repositories.length)} repositories (${String(active)} active)`,
        `${String(requests.sent)} requests, ${String(requests.notModified)} not modified`,
        core === null ? null : `quota ${String(core.remaining)}/${String(core.limit)}`,
        notRefreshed.length > 0 ? `${String(notRefreshed.length)} not refreshed` : null,
        outcome.carried > 0 ? `${String(outcome.carried)} shown from earlier data` : null,
        pollInterval.reason === 'base' ? next : `${next} (${pollInterval.reason})`,
      ];
      line = `Collected ${parts.filter((part) => part !== null).join(' · ')}`;
      summary = `success:${pollInterval.reason}:${String(outcome.carried)}`;
    }

    const now = this.#now();
    const since = now - this.#lastLineAt;
    if (
      summary !== this.#lastSummary ||
      (changed && since >= CHANGE_LOG_MS) ||
      since >= QUIET_LOG_MS
    ) {
      this.#log(line);
      this.#lastLineAt = now;
    }
    this.#lastSummary = summary;
  }
}
