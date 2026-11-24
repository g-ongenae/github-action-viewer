// Synthetic views and payloads for the page's tests. All names are made up.

import { isActiveRunState, summariseRunStates, type RunState } from '../core/run-state.ts';
import type { LineView, RepositoryView, RunView, Snapshot } from '../core/snapshot.ts';
import type { ConfigStatus, Heartbeat, PagePayload, ServerStatus } from '../server/payload.ts';

export const NOW = Date.parse('2026-11-13T12:00:00Z');

export function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

export function runView(overrides: Partial<RunView> = {}): RunView {
  const id = overrides.id ?? 1;
  return {
    id,
    workflowName: 'CI',
    state: 'success',
    url: `https://github.com/octo-org/widgets/actions/runs/${String(id)}`,
    event: 'push',
    runNumber: id,
    runAttempt: 1,
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    superseded: false,
    createdAt: iso(10),
    startedAt: iso(10),
    updatedAt: iso(5),
    ...overrides,
  };
}

/**
 * A line on `main` whose derived fields (`state`, `commitState`, `counts`, `failed`, `active`)
 * are computed from `runs` like the core does; override anything else.
 */
export function lineView(
  overrides: Partial<Omit<LineView, 'state' | 'commitState' | 'counts' | 'failed' | 'active'>> = {},
): LineView {
  const runs = overrides.runs ?? [runView()];
  const current = summariseRunStates(runs.filter((run) => !run.superseded).map((run) => run.state));
  const all = summariseRunStates(runs.map((run) => run.state));
  return {
    key: 'branch:main',
    kind: 'default_branch',
    label: 'main',
    pullRequest: null,
    date: iso(10),
    updatedAt: iso(5),
    commit: {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Commit title',
      authorName: 'Mona Lisa',
    },
    ...overrides,
    runs,
    state: all.state,
    commitState: current.state,
    counts: current.counts,
    failed: current.failed,
    active: runs.some((run) => isActiveRunState(run.state)),
  };
}

/** A line whose single run is in `state`. */
export function lineIn(state: RunState, overrides: Partial<LineView> = {}): LineView {
  return lineView({ ...overrides, runs: [runView({ state })] });
}

export function prLine(number: number, overrides: Partial<LineView> = {}): LineView {
  return lineView({
    key: `pr:${String(number)}`,
    kind: 'pull_request',
    label: `#${String(number)}`,
    pullRequest: {
      number,
      title: `Pull request ${String(number)}`,
      author: 'octocat',
      url: `https://github.com/octo-org/widgets/pull/${String(number)}`,
      draft: false,
    },
    ...overrides,
  });
}

export function repositoryView(
  fullName: string,
  lines: readonly LineView[],
  overrides: Partial<RepositoryView> = {},
): RepositoryView {
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    reasons: ['own'],
    active: lines.some((line) => line.active),
    lines,
    ...overrides,
  };
}

export function snapshot(
  repositories: readonly RepositoryView[],
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    generatedAt: iso(0),
    viewer: 'octocat',
    repositories,
    problems: [],
    rateLimit: null,
    ...overrides,
  };
}

export function configStatus(overrides: Partial<ConfigStatus> = {}): ConfigStatus {
  return {
    state: 'ok',
    problems: null,
    fallback: null,
    maintainedRepositories: [],
    editing: 'on',
    ...overrides,
  };
}

export function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    lastCheckedAt: iso(0.1),
    lastSuccessAt: iso(0.1),
    nextPollAt: new Date(NOW + 15_000).toISOString(),
    stale: null,
    staleRepositories: [],
    pollInterval: { baseSeconds: 15, currentSeconds: 15, reason: 'base' },
    rateLimits: { core: null, search: null, retryAt: null },
    config: configStatus(),
    ...overrides,
  };
}

export function payload(
  repositories: readonly RepositoryView[] | null,
  statusOverrides: Partial<ServerStatus> = {},
): PagePayload {
  return {
    snapshot: repositories === null ? null : snapshot(repositories),
    status: status(statusOverrides),
  };
}

export function heartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  const { lastCheckedAt, lastSuccessAt, nextPollAt, pollInterval, rateLimits } = status();
  return {
    serverTime: iso(0),
    lastCheckedAt,
    lastSuccessAt,
    nextPollAt,
    pollInterval,
    rateLimits,
    ...overrides,
  };
}

/** The skeleton of index.html that the renderer fills. */
export const PAGE_SKELETON = `
  <header>
    <h1>My GitHub Actions</h1>
    <p id="status"></p>
    <button id="add-repository" type="button" hidden>Add repository</button>
  </header>
  <details id="notice-disclosure" hidden>
    <summary><span id="notice-count"></span><span id="notice-preview"></span></summary>
    <ul id="notices"></ul>
  </details>
  <div id="filters" hidden></div>
  <main><div id="empty"></div><div id="repositories"></div></main>
  <p id="announcer" role="status"></p>
`;

/** A `Storage` kept in memory, standing for the browser's local storage. */
export class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}
