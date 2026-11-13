import type { PullRequestInput, RepositoryInput, WatchReason, WorkflowRunInput } from './inputs.ts';
import { nameKey, sameName } from './repository-name.ts';
import { isActiveRunState, normaliseRunState, summariseRunStates } from './run-state.ts';
import type {
  CommitView,
  LineKind,
  LineView,
  Problem,
  RateLimitView,
  RepositoryView,
  RunView,
  Snapshot,
} from './snapshot.ts';

/** Everything collected in one polling cycle. */
export interface SnapshotInput {
  /** Login of the user the token belongs to. */
  readonly viewer: string;
  readonly repositories: readonly RepositoryInput[];
  readonly problems: readonly Problem[];
  readonly rateLimit: RateLimitView | null;
}

/** Parameters of {@link buildSnapshot} that do not come from GitHub. */
export interface SnapshotOptions {
  /** The current time; the snapshot's `generatedAt` and the reference for the recent window. */
  readonly now: Date;
  /**
   * How long a finished line that is not always shown (see {@link buildRepositoryView}) stays on
   * the page after its last update, in hours.
   */
  readonly recentWindowHours: number;
}

/**
 * Builds the page from the collected data. Repositories without any visible line are omitted.
 *
 * Repository order: repositories with an active line first, then by most recent line date
 * (newest first), then by name. Lines are ordered by {@link buildRepositoryView}. The result only
 * depends on the arguments, so re-rendering the same data never reorders the page.
 */
export function buildSnapshot(input: SnapshotInput, options: SnapshotOptions): Snapshot {
  const repositories = input.repositories
    .map((repository) => buildRepositoryView(repository, input.viewer, options))
    .filter((view) => view !== null)
    .sort(compareRepositories);
  return {
    generatedAt: options.now.toISOString(),
    viewer: input.viewer,
    repositories,
    problems: input.problems,
    rateLimit: input.rateLimit,
  };
}

/**
 * Builds the lines of one repository; null when none is visible.
 *
 * Grouping: each run goes to one line (or to several pull request lines when GitHub associates it
 * with several open pull requests):
 * 1. a run on the default branch of the repository itself goes to the default-branch line — a
 *    fork's `main` is not the default branch, the head repository tells them apart;
 * 2. otherwise, a run goes to the open pull requests GitHub associates with it (`pull_requests`)
 *    or, when there are none (always the case for forks), to the open pull requests with the
 *    same head commit, or the same head branch in the same head repository;
 * 3. otherwise, a run on a branch of the repository itself goes to that branch's line;
 * 4. any other run (e.g. for a closed fork pull request) is dropped.
 *
 * Visibility: in a repository the viewer owns or maintains, the default-branch line and the
 * viewer's pull requests are always shown; other lines only while active or updated within the
 * recent window. In a repository shown only because of the viewer's pull requests, only those
 * pull requests are shown.
 *
 * Order: default branch first, then by line date (newest first), then by key.
 */
export function buildRepositoryView(
  repository: RepositoryInput,
  viewer: string,
  options: SnapshotOptions,
): RepositoryView | null {
  const watched = repository.reasons.includes('own') || repository.reasons.includes('maintained');
  const recentSince = options.now.getTime() - options.recentWindowHours * 3_600_000;

  const lines = [...groupRuns(repository).values()]
    .map(buildLine)
    .filter((line) => {
      const viewersPullRequest = sameName(line.pullRequest?.author ?? null, viewer);
      if (!watched) {
        return viewersPullRequest;
      }
      return (
        line.kind === 'default_branch' ||
        viewersPullRequest ||
        line.active ||
        Date.parse(line.updatedAt) >= recentSince
      );
    })
    .sort(compareLines);

  if (lines.length === 0) {
    return null;
  }
  return {
    fullName: repository.fullName,
    url: repository.url,
    reasons: WATCH_REASON_ORDER.filter((reason) => repository.reasons.includes(reason)),
    active: lines.some((line) => line.active),
    lines,
  };
}

const WATCH_REASON_ORDER: readonly WatchReason[] = ['own', 'maintained', 'my_pull_request'];

/** The runs of one ref, before they become a line. */
interface RefGroup {
  readonly key: string;
  readonly kind: LineKind;
  readonly label: string;
  readonly pullRequest: PullRequestInput | null;
  readonly runs: WorkflowRunInput[];
}

/** Sorts runs into refs (see the grouping rules on {@link buildRepositoryView}). */
function groupRuns(repository: RepositoryInput): Map<string, RefGroup> {
  const groups = new Map<string, RefGroup>();
  const add = (run: WorkflowRunInput, group: Omit<RefGroup, 'runs'>): void => {
    const existing = groups.get(group.key);
    if (existing) {
      existing.runs.push(run);
    } else {
      groups.set(group.key, { ...group, runs: [run] });
    }
  };

  for (const run of uniqueRuns(repository.runs)) {
    const onOwnBranch =
      sameName(run.headRepository, repository.fullName) && run.headBranch !== null;
    if (onOwnBranch && run.headBranch === repository.defaultBranch) {
      add(run, branchGroup(repository.defaultBranch, 'default_branch'));
      continue;
    }
    const pullRequests = pullRequestsOf(run, repository.pullRequests);
    for (const pullRequest of pullRequests) {
      add(run, {
        key: `pr:${String(pullRequest.number)}`,
        kind: 'pull_request',
        label: `#${String(pullRequest.number)}`,
        pullRequest,
      });
    }
    if (pullRequests.length === 0 && onOwnBranch) {
      add(run, branchGroup(run.headBranch, 'branch'));
    }
  }
  return groups;
}

function branchGroup(branch: string, kind: LineKind): Omit<RefGroup, 'runs'> {
  return { key: `branch:${branch}`, kind, label: branch, pullRequest: null };
}

/**
 * The open pull requests a run belongs to: GitHub's association first, then a match on the head
 * commit, or on the head branch within the same head repository.
 */
function pullRequestsOf(
  run: WorkflowRunInput,
  pullRequests: readonly PullRequestInput[],
): PullRequestInput[] {
  const associated = pullRequests.filter((pr) => run.pullRequestNumbers.includes(pr.number));
  if (associated.length > 0) {
    return associated;
  }
  return pullRequests.filter(
    (pr) =>
      pr.headSha === run.headSha ||
      (pr.headBranch === run.headBranch && sameName(pr.headRepository, run.headRepository)),
  );
}

/** Drops duplicate runs (e.g. from overlapping pages), keeping the most recent copy. */
function uniqueRuns(runs: readonly WorkflowRunInput[]): WorkflowRunInput[] {
  const byId = new Map<number, WorkflowRunInput>();
  for (const run of runs) {
    const existing = byId.get(run.id);
    if (!existing || compareRunRecency(run, existing) > 0) {
      byId.set(run.id, run);
    }
  }
  return [...byId.values()];
}

function buildLine(group: RefGroup): LineView {
  const sha = newestSha(group);
  const current = latestPerWorkflow(group.runs.filter((run) => run.headSha === sha));
  const superseded = group.runs.filter(
    (run) => run.headSha !== sha && isActiveRunState(stateOf(run)),
  );

  const runs = [
    ...current.sort(compareCurrentRuns).map((run) => toRunView(run, false)),
    ...superseded.sort(compareSupersededRuns).map((run) => toRunView(run, true)),
  ];
  const summary = summariseRunStates(current.map(stateOf));
  const pullRequest = group.pullRequest;

  return {
    key: group.key,
    kind: group.kind,
    label: group.label,
    pullRequest: pullRequest && {
      number: pullRequest.number,
      title: pullRequest.title,
      author: pullRequest.author,
      url: pullRequest.url,
      draft: pullRequest.draft,
    },
    state: summary.state,
    counts: summary.counts,
    failed: summary.failed,
    active: runs.some((run) => isActiveRunState(run.state)),
    date: latest(current.map((run) => run.createdAt)),
    updatedAt: latest(current.map((run) => run.updatedAt)),
    commit: commitOf(sha, current),
    runs,
  };
}

/**
 * The commit a line shows: the pull request's head commit when it has runs, otherwise the commit
 * of the most recently created run.
 */
function newestSha(group: RefGroup): string {
  const prSha = group.pullRequest?.headSha;
  if (prSha !== undefined && group.runs.some((run) => run.headSha === prSha)) {
    return prSha;
  }
  const [newest] = [...group.runs].sort((a, b) => compareRunCreation(b, a));
  // Groups are created with their first run, so `newest` always exists.
  return newest?.headSha ?? '';
}

/**
 * Keeps the latest run (highest run number, then attempt) of each workflow and event. The event
 * is part of the key because GitHub shows, say, the `push` and `pull_request` runs of the same
 * workflow on the same commit as two separate checks.
 */
function latestPerWorkflow(runs: readonly WorkflowRunInput[]): WorkflowRunInput[] {
  const latestByKey = new Map<string, WorkflowRunInput>();
  for (const run of runs) {
    const key = `${String(run.workflowId)}:${run.event}`;
    const existing = latestByKey.get(key);
    if (!existing || compareRunRecency(run, existing) > 0) {
      latestByKey.set(key, run);
    }
  }
  return [...latestByKey.values()];
}

function commitOf(sha: string, runs: readonly WorkflowRunInput[]): CommitView {
  const withCommit = runs.find((run) => run.headCommit !== null);
  const title = firstLine(withCommit?.headCommit?.message ?? '');
  return {
    sha,
    title: title === '' ? (runs[0]?.displayTitle ?? '') : title,
    authorName: withCommit?.headCommit?.authorName ?? null,
  };
}

function firstLine(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? '').trim();
}

function toRunView(run: WorkflowRunInput, superseded: boolean): RunView {
  return {
    id: run.id,
    workflowName: run.workflowName,
    state: stateOf(run),
    url: run.url,
    event: run.event,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    superseded,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

function stateOf(run: WorkflowRunInput): ReturnType<typeof normaliseRunState> {
  return normaliseRunState(run.status, run.conclusion);
}

// --- Ordering. Every comparator ends on a unique key so that sorting is fully deterministic. ---

function compareRepositories(a: RepositoryView, b: RepositoryView): number {
  return (
    Number(b.active) - Number(a.active) ||
    compareDates(newestLineDate(b), newestLineDate(a)) ||
    compareText(nameKey(a.fullName), nameKey(b.fullName)) ||
    compareText(a.fullName, b.fullName)
  );
}

function newestLineDate(repository: RepositoryView): string {
  return latest(repository.lines.map((line) => line.date));
}

function compareLines(a: LineView, b: LineView): number {
  return (
    Number(b.kind === 'default_branch') - Number(a.kind === 'default_branch') ||
    compareDates(b.date, a.date) ||
    compareText(a.key, b.key)
  );
}

/** Current runs: by workflow name, then event, then id. */
function compareCurrentRuns(a: WorkflowRunInput, b: WorkflowRunInput): number {
  return (
    compareText(a.workflowName, b.workflowName) || compareText(a.event, b.event) || a.id - b.id
  );
}

/** Superseded runs: newest first. */
function compareSupersededRuns(a: WorkflowRunInput, b: WorkflowRunInput): number {
  return compareRunCreation(b, a);
}

/** Orders two runs of the same workflow: run number, then attempt, then last update. */
function compareRunRecency(a: WorkflowRunInput, b: WorkflowRunInput): number {
  return (
    a.runNumber - b.runNumber ||
    a.runAttempt - b.runAttempt ||
    compareDates(a.updatedAt, b.updatedAt)
  );
}

/** Orders runs of any workflows by creation time, then id. */
function compareRunCreation(a: WorkflowRunInput, b: WorkflowRunInput): number {
  return compareDates(a.createdAt, b.createdAt) || a.id - b.id;
}

/** The latest of several ISO dates; '' for none. */
function latest(dates: readonly string[]): string {
  return dates.reduce((max, date) => (max === '' || compareDates(date, max) > 0 ? date : max), '');
}

function compareDates(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** Plain code-unit comparison: unlike `localeCompare`, it does not depend on the ICU locale. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
