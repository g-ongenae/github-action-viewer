// The snapshot: everything the page renders, sent as-is over HTTP and SSE. Every type here is
// plain JSON: dates are ISO 8601 strings, absent values are `null` (never `undefined`), and
// collections are arrays in display order.

import type { WatchReason } from './inputs.ts';
import type { RunState } from './run-state.ts';

/** The whole page at one point in time. */
export interface Snapshot {
  /** When the snapshot was built. */
  readonly generatedAt: string;
  /** Login of the user the token belongs to. */
  readonly viewer: string;
  /** Repositories with at least one line, in display order (see `buildSnapshot`). */
  readonly repositories: readonly RepositoryView[];
  /** Non-fatal problems to show above the repositories, in the order they were reported. */
  readonly problems: readonly Problem[];
  /** GitHub API quota as of the last response; null before any response. */
  readonly rateLimit: RateLimitView | null;
}

/** A repository and the lines shown for it. */
export interface RepositoryView {
  /** `owner/name`, with GitHub's casing. */
  readonly fullName: string;
  /** Repository page on github.com. */
  readonly url: string;
  /** Why the repository is shown, in the order `own`, `maintained`, `my_pull_request`. */
  readonly reasons: readonly WatchReason[];
  /** Whether any of its lines has an active run. */
  readonly active: boolean;
  /** Lines in display order: default branch first, then newest first. Never empty. */
  readonly lines: readonly LineView[];
}

/** What a line follows. */
export type LineKind = 'default_branch' | 'branch' | 'pull_request';

/**
 * One line of the page: a ref (the default branch, another branch or tag, or a pull request) and
 * the workflow runs of its newest commit.
 */
export interface LineView {
  /** Stable identifier within the repository: `branch:<name>` or `pr:<number>`. */
  readonly key: string;
  readonly kind: LineKind;
  /** `main`, `feature/x`, or `#123`. */
  readonly label: string;
  /** The pull request, for `pull_request` lines; null otherwise. */
  readonly pullRequest: PullRequestView | null;
  /**
   * What the line's badge shows: the combined state of all its runs, superseded ones included
   * (see `RUN_STATE_PRECEDENCE`). It reads active whenever anything on the ref still runs.
   */
  readonly state: RunState;
  /**
   * Verdict on the newest commit: the combined state of the current runs only. Differs from
   * `state` while a run of an older commit is still active, e.g. "running (older commit), latest
   * commit failed".
   */
  readonly commitState: RunState;
  /** Number of current runs (newest commit) in each state; every state is present, zero included. */
  readonly counts: Readonly<Record<RunState, number>>;
  /** Number of current runs (newest commit) that failed or timed out. */
  readonly failed: number;
  /** Whether any run of the line is active, superseded ones included. */
  readonly active: boolean;
  /** Line date: when the newest current run was created. Stable while runs progress. */
  readonly date: string;
  /** Latest `updatedAt` among the current runs (newest commit). */
  readonly updatedAt: string;
  /** The newest commit of the ref, which the current runs ran on. */
  readonly commit: CommitView;
  /**
   * Runs behind the line: the current runs (latest run per workflow and event on `commit`), then
   * runs still active on older commits of the ref (`superseded: true`).
   */
  readonly runs: readonly RunView[];
}

/** The pull request of a `pull_request` line. */
export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  /** Login of the author; null if unknown (deleted account). */
  readonly author: string | null;
  readonly url: string;
  readonly draft: boolean;
}

/** A commit, as shown on a line. */
export interface CommitView {
  readonly sha: string;
  /** First line of the commit message (the run's display title if GitHub sent no commit). */
  readonly title: string;
  /** Git author name; null if unknown. */
  readonly authorName: string | null;
}

/** One workflow run behind a line. */
export interface RunView {
  readonly id: number;
  readonly workflowName: string;
  readonly state: RunState;
  /** Run page on github.com. */
  readonly url: string;
  /** Triggering event, e.g. `push`, `pull_request`. */
  readonly event: string;
  readonly runNumber: number;
  readonly runAttempt: number;
  /** Commit the run is for: the line's commit, or an older one when `superseded`. */
  readonly headSha: string;
  /** True for a run still active on an older commit of the ref. */
  readonly superseded: boolean;
  readonly createdAt: string;
  /** When the latest attempt started; null if GitHub did not say. */
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

/** A problem that does not prevent showing the rest of the page. */
export type Problem =
  /** A repository could not be read (missing, no access, server error…). */
  | {
      readonly kind: 'repository';
      /** `owner/name` as configured or discovered. */
      readonly repository: string;
      /** HTTP status of the failed response; null for network errors. */
      readonly httpStatus: number | null;
      readonly message: string;
    }
  /** The API quota is exhausted; data is stale until `resetAt`. */
  | { readonly kind: 'rate_limited'; readonly resetAt: string; readonly message: string }
  /** Anything else worth telling the viewer. */
  | { readonly kind: 'other'; readonly message: string };

/** GitHub API quota, from the `x-ratelimit-*` response headers. */
export interface RateLimitView {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}
