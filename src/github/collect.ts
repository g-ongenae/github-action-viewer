import { buildSnapshot } from '../core/build-snapshot.ts';
import type { Config } from '../core/config.ts';
import type { PullRequestInput, RepositoryInput, WorkflowRunInput } from '../core/inputs.ts';
import { nameKey, sameName } from '../core/repository-name.ts';
import type { Problem, Snapshot } from '../core/snapshot.ts';
import { resolveWatchList, type WatchedRepository } from '../core/watch-list.ts';
import type { GitHubClient, RateLimitStatus } from './client.ts';
import { GitHubError, NotFoundError, RateLimitError } from './errors.ts';
import {
  parsePullRequestDetails,
  parsePullRequestList,
  parsePullRequestSearch,
  parseRepository,
  parseRepositoryList,
  parseViewer,
  parseWorkflowRunList,
  type PullRequestReference,
  type RepositoryInfo,
} from './mapping.ts';

/** Runs fetched per watched repository: the most recent page, whatever their branch. */
export const RECENT_RUNS = 100;
/** Runs fetched for one ref (default branch or pull request) missing from the recent page. */
export const REF_RUNS = 30;
/** Pages of open pull requests fetched per watched repository (100 per page). */
export const PULL_REQUEST_PAGES = 3;
/** Repositories collected at the same time. GitHub recommends serial requests; a few is fine. */
export const DEFAULT_CONCURRENCY = 4;

export interface CollectOptions {
  /** The current time: the snapshot date and the reference of the push window. */
  readonly now: Date;
  /** Repositories collected at once; default {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number;
  /** Aborts the collection; its reason is rethrown. */
  readonly signal?: AbortSignal;
}

/** A snapshot, and what it cost. */
export interface CollectionResult {
  readonly snapshot: Snapshot;
  /** Requests this collection sent, of which `notModified` were free `304`s. */
  readonly requests: { readonly sent: number; readonly notModified: number };
  /** Latest known quotas; `search` has its own (30 requests per minute). */
  readonly rateLimits: {
    readonly core: RateLimitStatus | null;
    readonly search: RateLimitStatus | null;
  };
  /** Set when a rate limit was hit: send nothing before this time. */
  readonly retryAt: Date | null;
  /**
   * Watched repositories missing from the snapshot because they could not be read (see
   * `snapshot.problems`) or were not reached before a rate limit. The caller may keep showing
   * their previous state.
   */
  readonly notRefreshed: readonly string[];
}

/** The viewer's login never changes for a given token: fetched once per client. */
const viewers = new WeakMap<GitHubClient, string>();

/**
 * Collects everything the page shows, in one pass:
 *
 * 1. the viewer (once per client), their own repositories and their open pull requests;
 * 2. the watch list ({@link resolveWatchList});
 * 3. per repository, with bounded concurrency: for a repository the viewer owns or maintains,
 *    the most recent runs and every open pull request; for a repository present only because of
 *    the viewer's pull requests, those pull requests and the runs of their head commits.
 *
 * Failures are isolated: a repository that cannot be read becomes a problem on the snapshot. A
 * rate limit stops the collection but still returns what was collected, with a `rate_limited`
 * problem and {@link CollectionResult.retryAt}. Only a failure to identify the viewer throws.
 */
export async function collectSnapshot(
  client: GitHubClient,
  config: Config,
  options: CollectOptions,
): Promise<CollectionResult> {
  const before = client.stats;
  const { now, signal } = options;
  const problems: Problem[] = [];
  let rateLimit: RateLimitError | null = null;

  /** Runs `task`; a GitHub failure is recorded and yields `fallback`. Other errors propagate. */
  const attempt = async <T>(
    task: () => Promise<T>,
    onFailure: (error: GitHubError) => void,
    fallback: T,
  ): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      if (error instanceof RateLimitError) {
        if (rateLimit === null || error.retryAt > rateLimit.retryAt) {
          rateLimit = error;
        }
        return fallback;
      }
      if (error instanceof GitHubError) {
        onFailure(error);
        return fallback;
      }
      throw error;
    }
  };

  const viewer = await getViewer(client, signal);

  const [ownRepositories, myPullRequests] = await Promise.all([
    config.includeOwnRepositories
      ? attempt(
          () => listOwnRepositories(client, config, now, signal),
          (error) => problems.push(other(`Could not list your repositories: ${error.message}`)),
          [],
        )
      : [],
    config.includeMyPullRequests
      ? attempt(
          () => searchOpenPullRequests(client, viewer, problems, signal),
          (error) => problems.push(other(`Could not search your pull requests: ${error.message}`)),
          [],
        )
      : [],
  ]);

  const watchList = resolveWatchList(
    config,
    {
      ownRepositories,
      pullRequestRepositories: myPullRequests.map((reference) => reference.repository),
    },
    now,
  );
  const known = new Map(ownRepositories.map((info) => [nameKey(info.fullName), info]));

  const notRefreshed: string[] = [];
  let skipped = 0;
  const repositories = await mapWithConcurrency(
    watchList,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (entry): Promise<RepositoryInput | null> => {
      if (rateLimit !== null) {
        skipped += 1;
        notRefreshed.push(entry.fullName);
        return null;
      }
      const result = await attempt<RepositoryInput | null>(
        () =>
          isWatched(entry)
            ? collectWatchedRepository(client, entry, known, viewer, signal)
            : collectPullRequestRepository(
                client,
                entry,
                myPullRequests.filter((reference) =>
                  sameName(reference.repository, entry.fullName),
                ),
                signal,
              ),
        (error) => problems.push(repositoryProblem(entry.fullName, error)),
        null,
      );
      if (result === null) {
        notRefreshed.push(entry.fullName);
      }
      return result;
    },
  );

  const limited = rateLimit as RateLimitError | null;
  if (limited !== null) {
    const unreached =
      skipped > 0
        ? `; ${String(skipped)} of ${String(watchList.length)} repositories were not refreshed`
        : '';
    problems.push({
      kind: 'rate_limited',
      resetAt: limited.retryAt.toISOString(),
      message: `GitHub ${limited.kind} rate limit reached${limited.resource === null ? '' : ` (${limited.resource})`}${unreached}.`,
    });
  }

  const core = client.rateLimit('core');
  const snapshot = buildSnapshot(
    {
      viewer,
      repositories: repositories.filter((repository) => repository !== null),
      problems,
      rateLimit: core && {
        limit: core.limit,
        remaining: core.remaining,
        resetAt: core.resetAt.toISOString(),
      },
    },
    { now, recentWindowHours: config.recentWindowHours },
  );
  const after = client.stats;
  return {
    snapshot,
    requests: {
      sent: after.requests - before.requests,
      notModified: after.notModified - before.notModified,
    },
    rateLimits: { core, search: client.rateLimit('search') },
    retryAt: limited?.retryAt ?? null,
    notRefreshed: notRefreshed.sort(),
  };
}

async function getViewer(client: GitHubClient, signal: AbortSignal | undefined): Promise<string> {
  let viewer = viewers.get(client);
  if (viewer === undefined) {
    viewer = await client.get('/user', {}, parseViewer, optional(signal));
    viewers.set(client, viewer);
  }
  return viewer;
}

/**
 * The viewer's repositories that are neither archived nor disabled, most recently pushed first.
 * With a push window, pagination stops at the first page that reaches past it.
 */
async function listOwnRepositories(
  client: GitHubClient,
  config: Config,
  now: Date,
  signal: AbortSignal | undefined,
): Promise<RepositoryInfo[]> {
  const days = config.ownRepositoriesPushedWithinDays;
  const pushedSince = days === null ? null : now.getTime() - days * 86_400_000;
  const repositories: RepositoryInfo[] = [];
  const pages = client.pages(
    '/user/repos',
    { affiliation: 'owner', sort: 'pushed', direction: 'desc', per_page: 100 },
    parseRepositoryList,
    { maxPages: 10, ...optional(signal) },
  );
  for await (const page of pages) {
    repositories.push(...page.data.filter((repository) => !repository.inactive));
    const pastWindow =
      pushedSince !== null &&
      page.data.some(
        (repository) =>
          repository.pushedAt === null || Date.parse(repository.pushedAt) < pushedSince,
      );
    if (pastWindow) {
      break;
    }
  }
  return repositories;
}

/** The viewer's open pull requests in non-archived repositories, through the search API. */
async function searchOpenPullRequests(
  client: GitHubClient,
  viewer: string,
  problems: Problem[],
  signal: AbortSignal | undefined,
): Promise<PullRequestReference[]> {
  const references: PullRequestReference[] = [];
  const pages = client.pages(
    '/search/issues',
    { q: `is:pr is:open archived:false author:${viewer}`, per_page: 100 },
    parsePullRequestSearch,
    { maxPages: 10, ...optional(signal) },
  );
  let incomplete = false;
  for await (const page of pages) {
    references.push(...page.data.pullRequests);
    incomplete ||= page.data.incomplete;
  }
  if (incomplete) {
    problems.push(other('GitHub search timed out: some of your pull requests may be missing.'));
  }
  return references;
}

function isWatched(entry: WatchedRepository): boolean {
  return entry.reasons.includes('own') || entry.reasons.includes('maintained');
}

/**
 * A repository the viewer owns or maintains: its most recent runs and all its open pull
 * requests. When the recent page is full, the default branch and the viewer's pull requests may
 * have runs older than it; each of them without a run in the page gets its own small request, so
 * that their lines (always shown) do not vanish in a busy repository.
 */
async function collectWatchedRepository(
  client: GitHubClient,
  entry: WatchedRepository,
  known: ReadonlyMap<string, RepositoryInfo>,
  viewer: string,
  signal: AbortSignal | undefined,
): Promise<RepositoryInput> {
  const info =
    known.get(nameKey(entry.fullName)) ??
    (await client.get(repositoryPath(entry.fullName), {}, parseRepository, optional(signal)));
  const path = repositoryPath(info.fullName);

  const runs = await client.get(
    `${path}/actions/runs`,
    { per_page: RECENT_RUNS },
    parseWorkflowRunList,
    optional(signal),
  );
  const pullRequests: PullRequestInput[] = [];
  if (info.hasPullRequests) {
    const pages = client.pages(
      `${path}/pulls`,
      { state: 'open', per_page: 100 },
      parsePullRequestList,
      { maxPages: PULL_REQUEST_PAGES, ...optional(signal) },
    );
    for await (const page of pages) {
      pullRequests.push(...page.data);
    }
  }

  const extraRuns: WorkflowRunInput[] = [];
  if (runs.length >= RECENT_RUNS) {
    const onDefaultBranch = (run: WorkflowRunInput): boolean =>
      sameName(run.headRepository, info.fullName) && run.headBranch === info.defaultBranch;
    if (!runs.some(onDefaultBranch)) {
      extraRuns.push(
        ...(await client.get(
          `${path}/actions/runs`,
          { branch: info.defaultBranch, per_page: REF_RUNS },
          parseWorkflowRunList,
          optional(signal),
        )),
      );
    }
    for (const pullRequest of pullRequests) {
      if (
        sameName(pullRequest.author, viewer) &&
        !runs.some((run) => run.headSha === pullRequest.headSha)
      ) {
        extraRuns.push(...(await headCommitRuns(client, path, pullRequest, signal)));
      }
    }
  }

  return {
    fullName: info.fullName,
    url: info.url,
    defaultBranch: info.defaultBranch,
    reasons: entry.reasons,
    runs: [...runs, ...extraRuns],
    pullRequests,
  };
}

/**
 * A repository present only because of the viewer's pull requests: each of them (the search
 * result lacks the head commit) and the runs of its head commit. Pull requests closed since the
 * search index was updated are left out.
 */
async function collectPullRequestRepository(
  client: GitHubClient,
  entry: WatchedRepository,
  references: readonly PullRequestReference[],
  signal: AbortSignal | undefined,
): Promise<RepositoryInput | null> {
  const path = repositoryPath(entry.fullName);
  let info: RepositoryInfo | null = null;
  const pullRequests: PullRequestInput[] = [];
  const runs: WorkflowRunInput[] = [];
  for (const reference of references) {
    const details = await client.get(
      `${path}/pulls/${String(reference.number)}`,
      {},
      parsePullRequestDetails,
      optional(signal),
    );
    info ??= details.repository;
    if (details.open) {
      pullRequests.push(details.pullRequest);
      runs.push(...(await headCommitRuns(client, path, details.pullRequest, signal)));
    }
  }
  if (info === null) {
    return null;
  }
  return {
    fullName: info.fullName,
    url: info.url,
    defaultBranch: info.defaultBranch,
    reasons: entry.reasons,
    runs,
    pullRequests,
  };
}

function headCommitRuns(
  client: GitHubClient,
  path: string,
  pullRequest: PullRequestInput,
  signal: AbortSignal | undefined,
): Promise<WorkflowRunInput[]> {
  return client.get(
    `${path}/actions/runs`,
    { head_sha: pullRequest.headSha, per_page: REF_RUNS },
    parseWorkflowRunList,
    optional(signal),
  );
}

function repositoryPath(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function repositoryProblem(repository: string, error: GitHubError): Problem {
  const message =
    error instanceof NotFoundError
      ? `Not found, or the token cannot read it (renamed, deleted or access lost). ${error.message}`
      : error.message;
  return { kind: 'repository', repository, httpStatus: error.status, message };
}

function other(message: string): Problem {
  return { kind: 'other', message };
}

/** `{ signal }` when there is one (the options are `exactOptionalPropertyTypes`). */
function optional(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/** Maps `items` with at most `limit` calls of `fn` in flight; results keep the input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
