import { buildSnapshot } from '../core/build-snapshot.ts';
import type { Config } from '../core/config.ts';
import type {
  PullRequestInput,
  RepositoryInput,
  WatchReason,
  WorkflowRunInput,
} from '../core/inputs.ts';
import { nameKey, sameName } from '../core/repository-name.ts';
import type { Problem, Snapshot } from '../core/snapshot.ts';
import { resolveWatchList, type WatchedRepository } from '../core/watch-list.ts';
import type {
  GitHubClient,
  Page,
  Parser,
  Query,
  RateLimitStatus,
  RequestOptions,
} from './client.ts';
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
import { repositoryPath } from './repositories.ts';

/** Runs fetched per watched repository: the most recent page, whatever their branch. */
export const RECENT_RUNS = 100;
/** Runs fetched for one ref (default branch or pull request) missing from the recent page. */
export const REF_RUNS = 30;
/** Pages of open pull requests fetched per watched repository (100 per page). */
export const PULL_REQUEST_PAGES = 3;
/** Pages read from the repository list and from the search (100 per page). */
export const DISCOVERY_PAGES = 10;
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

/**
 * How completely a discovery source was read:
 * - `complete`: every page that matters was read;
 * - `partial`: some pages were read, but a later page failed, the page cap was reached, or the
 *   search API reported `incomplete_results`; what was read is used;
 * - `failed`: nothing could be read;
 * - `skipped`: the configuration turns the source off.
 */
export type DiscoveryState = 'complete' | 'partial' | 'failed' | 'skipped';

/**
 * A snapshot, what it cost, and how far it can be trusted.
 *
 * Every watched repository is in exactly one of {@link refreshed} and {@link notRefreshed}. A
 * caller keeping a published state should merge each collection into it repository by
 * repository (names compared case-insensitively):
 *
 * 1. in `refreshed`: take this snapshot's view of it; absent from `snapshot.repositories` means
 *    it has no line to show any more;
 * 2. in `notRefreshed`: keep the previous view; with none, use this snapshot's view if it has one;
 * 3. in neither (no longer watched, as far as this collection can tell): drop it only if
 *    {@link watchListComplete}; otherwise keep the previous view.
 *
 * Names: within one collection, each watched repository appears once, under the same name in
 * `snapshot.repositories`, in `refreshed` or `notRefreshed`, and in its repository problems.
 * That name is GitHub's current name if anything of the repository was read in this collection
 * (GitHub answers an old name with a redirect), and otherwise the name it was looked up by (from
 * the configuration or discovery). Watch-list entries that turn out to be the same repository
 * are reported once, keeping the view of the watched (own or maintained) entry. Nothing about
 * names is remembered from one collection to the next. When a name in the configuration's
 * `maintainedRepositories` turns out to be an old one, an `other` problem asks to update
 * `config.json`.
 *
 * Limitations of a rename, both transient and both gone once `config.json` uses the current
 * name: (a) while the configuration still uses the old name, a collection that cannot read the
 * repository at all reports it under the old name, so it cannot be matched to the view published
 * under the new name; that view then falls under rule 3 and may be dropped until the next
 * successful read; (b) after a rename, the view published under the old name stays (stale) next
 * to the new one until the source that listed it is read completely again.
 */
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
   * Watched repositories read completely: their view in `snapshot.repositories` (or its absence)
   * is authoritative. Sorted.
   */
  readonly refreshed: readonly string[];
  /**
   * Watched repositories whose view is missing or may be incomplete: they could not be read (see
   * `snapshot.problems`), were cut off by a rate limit, or depend on a search that was not
   * complete (shown only because of the viewer's pull requests, or with more open pull requests
   * than the cap, beyond which only the search names the viewer's). Sorted.
   */
  readonly notRefreshed: readonly string[];
  /** How completely the sources of the watch list were read. */
  readonly discovery: {
    /** The viewer's repositories (`GET /user/repos`). */
    readonly ownRepositories: DiscoveryState;
    /** The viewer's open pull requests (the search API). */
    readonly myPullRequests: DiscoveryState;
  };
  /**
   * Whether every enabled source was read completely, so that a repository missing from this
   * collection's watch list is really no longer watched.
   */
  readonly watchListComplete: boolean;
}

/** The viewer's login never changes for a given token: fetched once per client. */
const viewers = new WeakMap<GitHubClient, string>();

/** What happened to one entry of the watch list. */
interface Outcome {
  readonly entry: WatchedRepository;
  /** GitHub's current name if anything was read, else the name it was looked up by. */
  readonly name: string;
  readonly input: RepositoryInput | null;
  /** Whether `input` is a complete view (see {@link CollectionResult.refreshed}). */
  readonly complete: boolean;
  readonly failure: GitHubError | null;
}

/**
 * Collects everything the page shows, in one pass:
 *
 * 1. the viewer (once per client), their own repositories and their open pull requests;
 * 2. the watch list ({@link resolveWatchList});
 * 3. per repository, with bounded concurrency: for a repository the viewer owns or maintains,
 *    the most recent runs and the open pull requests (the viewer's always included); for a
 *    repository present only because of the viewer's pull requests, those pull requests and the
 *    runs of their head commits.
 *
 * Failures are isolated: a repository that cannot be read becomes a problem on the snapshot, and
 * a source of the watch list that fails is reported in {@link CollectionResult.discovery}. Once a
 * rate limit is hit, no further request is sent (requests already sent may complete; only an
 * exhausted search quota leaves the other requests going); what was collected is still returned,
 * with a `rate_limited` problem and {@link CollectionResult.retryAt}. Only a failure to identify
 * the viewer throws.
 */
export async function collectSnapshot(
  client: GitHubClient,
  config: Config,
  options: CollectOptions,
): Promise<CollectionResult> {
  const before = client.stats;
  const { now, signal } = options;
  const problems: Problem[] = [];

  const viewer = await getViewer(client, signal);
  const api = new GatedApi(client, signal);

  const [own, mine] = await Promise.all([
    config.includeOwnRepositories
      ? listOwnRepositories(api, config, now, problems)
      : skipped<RepositoryInfo>(),
    config.includeMyPullRequests
      ? searchOpenPullRequests(api, viewer, problems)
      : skipped<PullRequestReference>(),
  ]);

  const watchList = resolveWatchList(
    config,
    {
      ownRepositories: own.items,
      pullRequestRepositories: mine.items.map((reference) => reference.repository),
    },
    now,
  );
  const known = new Map(own.items.map((info) => [nameKey(info.fullName), info]));
  const searchComplete = mine.state === 'complete' || mine.state === 'skipped';

  const outcomes = await mapWithConcurrency(
    watchList,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (entry): Promise<Outcome> => {
      const references = mine.items.filter((reference) =>
        sameName(reference.repository, entry.fullName),
      );
      // Set as soon as GitHub tells the repository's current name, so that a later failure is
      // still reported under it.
      const resolved = { name: entry.fullName };
      try {
        api.throwIfStopped();
        let input: RepositoryInput;
        let complete: boolean;
        if (isWatched(entry)) {
          const watched = await collectWatchedRepository(
            api,
            entry,
            known,
            viewer,
            references,
            resolved,
          );
          input = watched.input;
          // The viewer's pull requests beyond the cap are known only from the search.
          complete = !watched.truncated || searchComplete;
        } else {
          input = await collectPullRequestRepository(api, entry, references, resolved);
          complete = searchComplete;
        }
        return { entry, name: input.fullName, input, complete, failure: null };
      } catch (error) {
        if (!(error instanceof GitHubError)) {
          throw error;
        }
        return { entry, name: resolved.name, input: null, complete: false, failure: error };
      }
    },
  );

  for (const outcome of outcomes) {
    const configured = config.maintainedRepositories.find((name) =>
      sameName(name, outcome.entry.fullName),
    );
    if (configured !== undefined && !sameName(configured, outcome.name)) {
      problems.push(
        other(
          `${configured} in config.json is now ${outcome.name}: update maintainedRepositories.`,
        ),
      );
    }
  }

  // Entries can turn out to be the same repository (an old and a current name): report each
  // repository once, from the broadest entry read (an own or maintained entry rather than a
  // pull-request-only one), with every reason, pull request and run read. It is complete if that
  // entry is and no entry of the repository failed: a complete watched entry has every open pull
  // request already.
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const group = groups.get(nameKey(outcome.name)) ?? [];
    group.push(outcome);
    groups.set(nameKey(outcome.name), group);
  }
  const refreshed: string[] = [];
  const notRefreshed: string[] = [];
  const repositories: RepositoryInput[] = [];
  let cutOff = 0;
  for (const [first, ...others] of groups.values()) {
    if (first === undefined) {
      continue;
    }
    const group = [first, ...others];
    const read = group.filter((outcome) => outcome.input !== null);
    const chosen = read.find((outcome) => isWatched(outcome.entry)) ?? read[0] ?? first;
    if (chosen.input !== null) {
      const inputs = read.flatMap((outcome) => (outcome.input === null ? [] : [outcome.input]));
      const pullRequests = new Map<number, PullRequestInput>();
      for (const pullRequest of inputs.flatMap((input) => input.pullRequests)) {
        pullRequests.set(pullRequest.number, pullRequest);
      }
      repositories.push({
        ...chosen.input,
        reasons: read.reduce<readonly WatchReason[]>(
          (reasons, outcome) => mergeReasons(reasons, outcome.entry.reasons),
          [],
        ),
        // Runs read twice are collapsed by the core.
        runs: inputs.flatMap((input) => input.runs),
        pullRequests: [...pullRequests.values()],
      });
    }
    const { name } = chosen;
    const complete = chosen.complete && group.every((outcome) => outcome.failure === null);
    (complete ? refreshed : notRefreshed).push(name);
    for (const { failure } of group) {
      if (failure instanceof RateLimitError) {
        cutOff += 1;
      } else if (failure !== null) {
        problems.push(repositoryProblem(name, failure));
      }
    }
  }

  const limited = api.rateLimit;
  if (limited !== null) {
    const unreached =
      cutOff > 0
        ? `; ${String(cutOff)} of ${String(watchList.length)} repositories were not refreshed`
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
      repositories,
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
  const complete = (state: DiscoveryState): boolean => state === 'complete' || state === 'skipped';
  return {
    snapshot,
    requests: {
      sent: after.requests - before.requests,
      notModified: after.notModified - before.notModified,
    },
    rateLimits: { core, search: client.rateLimit('search') },
    retryAt: limited?.retryAt ?? null,
    refreshed: refreshed.sort(),
    notRefreshed: notRefreshed.sort(),
    discovery: { ownRepositories: own.state, myPullRequests: mine.state },
    watchListComplete: complete(own.state) && complete(mine.state),
  };
}

/**
 * The client as the collector uses it, for one collection: no request (and no further page) is
 * sent once a rate limit was hit. Requests already sent are left to complete.
 */
class GatedApi {
  readonly #client: GitHubClient;
  readonly #signal: AbortSignal | undefined;
  /** The rate limit that stops every request; an exhausted search quota stops only the search. */
  #stop: RateLimitError | null = null;
  /** The rate limit with the latest retry time, stopping or not. */
  #latest: RateLimitError | null = null;

  constructor(client: GitHubClient, signal: AbortSignal | undefined) {
    this.#client = client;
    this.#signal = signal;
  }

  get rateLimit(): RateLimitError | null {
    return this.#latest;
  }

  /** Throws the rate limit that stopped the collection, if any. */
  throwIfStopped(): void {
    if (this.#stop !== null) {
      throw this.#stop;
    }
  }

  async get<T>(path: string, query: Query, parse: Parser<T>): Promise<T> {
    this.throwIfStopped();
    try {
      return await this.#client.get(path, query, parse, this.#options());
    } catch (error) {
      throw this.#noted(error);
    }
  }

  async *pages<T>(
    path: string,
    query: Query,
    parse: Parser<T>,
    maxPages: number,
  ): AsyncGenerator<Page<T>, void, undefined> {
    // The client fetches a page only when asked for it: checking before each `next()` gates
    // every page.
    const pages = this.#client.pages(path, query, parse, { maxPages, ...this.#options() });
    try {
      for (;;) {
        this.throwIfStopped();
        let result: IteratorResult<Page<T>, void>;
        try {
          result = await pages.next();
        } catch (error) {
          throw this.#noted(error);
        }
        if (result.done === true) {
          return;
        }
        yield result.value;
      }
    } finally {
      await pages.return(undefined);
    }
  }

  #noted(error: unknown): unknown {
    if (error instanceof RateLimitError) {
      if (this.#latest === null || error.retryAt > this.#latest.retryAt) {
        this.#latest = error;
      }
      const searchQuotaOnly = error.kind === 'primary' && error.resource === 'search';
      if (!searchQuotaOnly) {
        this.#stop ??= error;
      }
    }
    return error;
  }

  /** Passes the stop state to the client, which checks it before every send (redirects too). */
  #options(): RequestOptions {
    const gate = (): void => {
      this.throwIfStopped();
    };
    return this.#signal ? { signal: this.#signal, gate } : { gate };
  }
}

async function getViewer(client: GitHubClient, signal: AbortSignal | undefined): Promise<string> {
  let viewer = viewers.get(client);
  if (viewer === undefined) {
    viewer = await client.get('/user', {}, parseViewer, signal ? { signal } : {});
    viewers.set(client, viewer);
  }
  return viewer;
}

/** What a discovery source yielded, and how completely it was read. */
interface Discovered<T> {
  readonly items: T[];
  readonly state: DiscoveryState;
}

function skipped<T>(): Discovered<T> {
  return { items: [], state: 'skipped' };
}

/**
 * Reads the pages of a discovery source, keeping every page read before a failure. `read` takes a
 * page's items and returns true once nothing further is needed (the source is then complete). A
 * GitHub failure becomes a problem (a rate limit is reported by the caller); others propagate.
 */
async function discover<P, T>(
  pages: AsyncIterable<Page<P>>,
  read: (page: Page<P>, items: T[]) => boolean,
  describeFailure: (error: GitHubError) => string,
  problems: Problem[],
): Promise<Discovered<T>> {
  const items: T[] = [];
  let pagesRead = 0;
  let complete = false;
  try {
    for await (const page of pages) {
      pagesRead += 1;
      if (read(page, items) || !page.hasNext) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    if (!(error instanceof RateLimitError)) {
      problems.push(other(describeFailure(error)));
    }
  }
  return { items, state: complete ? 'complete' : pagesRead > 0 ? 'partial' : 'failed' };
}

/**
 * The viewer's repositories that are neither archived nor disabled, most recently pushed first.
 * With a push window, pagination stops at the first page that reaches past it.
 */
function listOwnRepositories(
  api: GatedApi,
  config: Config,
  now: Date,
  problems: Problem[],
): Promise<Discovered<RepositoryInfo>> {
  const days = config.ownRepositoriesPushedWithinDays;
  const pushedSince = days === null ? null : now.getTime() - days * 86_400_000;
  return discover<RepositoryInfo[], RepositoryInfo>(
    api.pages(
      '/user/repos',
      { affiliation: 'owner', sort: 'pushed', direction: 'desc', per_page: 100 },
      parseRepositoryList,
      DISCOVERY_PAGES,
    ),
    (page, repositories) => {
      repositories.push(...page.data.filter((repository) => !repository.inactive));
      return (
        pushedSince !== null &&
        page.data.some(
          (repository) =>
            repository.pushedAt === null || Date.parse(repository.pushedAt) < pushedSince,
        )
      );
    },
    (error) => `Could not list your repositories: ${error.message}`,
    problems,
  );
}

/**
 * The viewer's open pull requests in non-archived repositories, through the search API. A search
 * that GitHub reports as incomplete is `partial`.
 */
async function searchOpenPullRequests(
  api: GatedApi,
  viewer: string,
  problems: Problem[],
): Promise<Discovered<PullRequestReference>> {
  const search = { incomplete: false };
  const result = await discover<ReturnType<typeof parsePullRequestSearch>, PullRequestReference>(
    api.pages(
      '/search/issues',
      { q: `is:pr is:open archived:false author:${viewer}`, per_page: 100 },
      parsePullRequestSearch,
      DISCOVERY_PAGES,
    ),
    (page, references) => {
      references.push(...page.data.pullRequests);
      search.incomplete ||= page.data.incomplete;
      return false;
    },
    (error) => `Could not search your pull requests: ${error.message}`,
    problems,
  );
  if (search.incomplete) {
    problems.push(other('GitHub search timed out: some of your pull requests may be missing.'));
    return { items: result.items, state: result.state === 'failed' ? 'failed' : 'partial' };
  }
  return result;
}

function isWatched(entry: WatchedRepository): boolean {
  return entry.reasons.includes('own') || entry.reasons.includes('maintained');
}

/**
 * A repository the viewer owns or maintains: its most recent runs and its open pull requests (up
 * to {@link PULL_REQUEST_PAGES} pages). The viewer's pull requests known from the search but cut
 * off by that cap are fetched one by one. When the recent page of runs is full, the default
 * branch and the viewer's pull requests may have runs older than it; each of them without a run
 * in the page gets its own small request, so that their lines (always shown) do not vanish in a
 * busy repository.
 */
async function collectWatchedRepository(
  api: GatedApi,
  entry: WatchedRepository,
  known: ReadonlyMap<string, RepositoryInfo>,
  viewer: string,
  references: readonly PullRequestReference[],
  resolved: { name: string },
): Promise<{ input: RepositoryInput; truncated: boolean }> {
  const info =
    known.get(nameKey(entry.fullName)) ??
    (await api.get(repositoryPath(entry.fullName), {}, parseRepository));
  resolved.name = info.fullName;
  const path = repositoryPath(info.fullName);

  const runs = await api.get(
    `${path}/actions/runs`,
    { per_page: RECENT_RUNS },
    parseWorkflowRunList,
  );
  const pullRequests: PullRequestInput[] = [];
  let truncated = false;
  if (info.hasPullRequests) {
    const pages = api.pages(
      `${path}/pulls`,
      { state: 'open', per_page: 100 },
      parsePullRequestList,
      PULL_REQUEST_PAGES,
    );
    for await (const page of pages) {
      pullRequests.push(...page.data);
      truncated = page.hasNext;
    }
  }
  if (truncated) {
    for (const reference of references) {
      if (!pullRequests.some((pullRequest) => pullRequest.number === reference.number)) {
        const details = await api.get(
          `${path}/pulls/${String(reference.number)}`,
          {},
          parsePullRequestDetails,
        );
        if (details.open) {
          pullRequests.push(details.pullRequest);
        }
      }
    }
  }

  const extraRuns: WorkflowRunInput[] = [];
  if (runs.length >= RECENT_RUNS) {
    const onDefaultBranch = (run: WorkflowRunInput): boolean =>
      sameName(run.headRepository, info.fullName) && run.headBranch === info.defaultBranch;
    if (!runs.some(onDefaultBranch)) {
      extraRuns.push(
        ...(await api.get(
          `${path}/actions/runs`,
          { branch: info.defaultBranch, per_page: REF_RUNS },
          parseWorkflowRunList,
        )),
      );
    }
    for (const pullRequest of pullRequests) {
      if (
        sameName(pullRequest.author, viewer) &&
        !runs.some((run) => run.headSha === pullRequest.headSha)
      ) {
        extraRuns.push(...(await headCommitRuns(api, path, pullRequest)));
      }
    }
  }

  return {
    input: {
      fullName: info.fullName,
      url: info.url,
      defaultBranch: info.defaultBranch,
      reasons: entry.reasons,
      runs: [...runs, ...extraRuns],
      pullRequests,
    },
    truncated,
  };
}

/**
 * A repository present only because of the viewer's pull requests: each of them (the search
 * result lacks the head commit) and the runs of its head commit. Pull requests closed since the
 * search index was updated are left out.
 */
async function collectPullRequestRepository(
  api: GatedApi,
  entry: WatchedRepository,
  references: readonly PullRequestReference[],
  resolved: { name: string },
): Promise<RepositoryInput> {
  let path = repositoryPath(entry.fullName);
  let info: RepositoryInfo | null = null;
  const pullRequests: PullRequestInput[] = [];
  const runs: WorkflowRunInput[] = [];
  for (const reference of references) {
    const details = await api.get(
      `${path}/pulls/${String(reference.number)}`,
      {},
      parsePullRequestDetails,
    );
    if (info === null) {
      // Under its current name from now on, should the search have used an old one.
      info = details.repository;
      path = repositoryPath(info.fullName);
      resolved.name = info.fullName;
    }
    if (details.open) {
      pullRequests.push(details.pullRequest);
      runs.push(...(await headCommitRuns(api, path, details.pullRequest)));
    }
  }
  return {
    // The watch list has an entry here only because of a search reference, so `info` is set.
    fullName: info?.fullName ?? entry.fullName,
    url: info?.url ?? `https://github.com/${entry.fullName}`,
    defaultBranch: info?.defaultBranch ?? '',
    reasons: entry.reasons,
    runs,
    pullRequests,
  };
}

function headCommitRuns(
  api: GatedApi,
  path: string,
  pullRequest: PullRequestInput,
): Promise<WorkflowRunInput[]> {
  return api.get(
    `${path}/actions/runs`,
    { head_sha: pullRequest.headSha, per_page: REF_RUNS },
    parseWorkflowRunList,
  );
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

const WATCH_REASONS: readonly WatchReason[] = ['own', 'maintained', 'my_pull_request'];

function mergeReasons(a: readonly WatchReason[], b: readonly WatchReason[]): WatchReason[] {
  return WATCH_REASONS.filter((reason) => a.includes(reason) || b.includes(reason));
}
