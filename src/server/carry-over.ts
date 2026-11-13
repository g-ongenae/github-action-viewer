import { compareLines, compareRepositories } from '../core/build-snapshot.ts';
import { nameKey } from '../core/repository-name.ts';
import type { LineView, Problem, RepositoryView, Snapshot } from '../core/snapshot.ts';
import type { CollectionResult } from '../github/collect.ts';
import type { StaleRepository } from './payload.ts';

/** What the page shows: a snapshot, and which of its parts come from earlier collections. */
export interface Published {
  readonly snapshot: Snapshot;
  readonly staleRepositories: readonly StaleRepository[];
}

/** What a collection read completely, i.e. what its absences can be trusted for. */
export interface Freshness {
  /** Watched repositories it could not refresh (rate limit, failure), as `nameKey`s. */
  readonly notRefreshed: ReadonlySet<string>;
  /** Watched repositories that failed for good (gone, or no access any more), as `nameKey`s. */
  readonly gone: ReadonlySet<string>;
  /** Whether the viewer's own repositories were listed completely. */
  readonly ownRepositoriesComplete: boolean;
  /** Whether the viewer's open pull requests were listed completely (the search API). */
  readonly myPullRequestsComplete: boolean;
}

/**
 * HTTP statuses after which a repository is dropped rather than carried over: it is gone, or the
 * token cannot read it any more, so its old state would mislead instead of being merely late.
 */
const PERMANENT_FAILURES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/**
 * Reads from a collection result what it read completely. The one place that knows how
 * `collectSnapshot` reports this.
 */
export function freshnessOf(result: CollectionResult): Freshness {
  return {
    notRefreshed: new Set(result.notRefreshed.map(nameKey)),
    gone: new Set(
      result.snapshot.problems
        .filter(isPermanentFailure)
        .map((problem) => nameKey(problem.repository)),
    ),
    // TODO(#3): read the discovery state that `collectSnapshot` is gaining. Until then a failed
    // discovery is indistinguishable from an empty one.
    ownRepositoriesComplete: true,
    myPullRequestsComplete: true,
  };
}

/**
 * Merges a collection into what the page showed, so that nothing disappears for lack of data:
 * a repository or a pull request line is only removed when the source that would list it was
 * read completely and no longer lists it. Everything else that vanished is kept as it was, and
 * listed in `staleRepositories` with the time of its last refresh.
 *
 * - A repository the collection could not refresh (`notRefreshed`) keeps its previous state,
 *   unless it failed for good ({@link PERMANENT_FAILURES}); its problem stays on the snapshot.
 * - A repository shown because the viewer owns it, or has a pull request there, is kept while
 *   that list was not read completely.
 * - In a repository shown only for the viewer's pull requests, a pull request line that vanished
 *   is kept while the viewer's pull requests were not read completely. (Elsewhere, pull request
 *   lines come from the repository's own list, which is complete when the repository is.)
 */
export function carryOver(previous: Published | null, result: CollectionResult): Published {
  return mergeWithPrevious(previous, result.snapshot, freshnessOf(result));
}

/** {@link carryOver}, with what the collection read completely given explicitly. */
export function mergeWithPrevious(
  previous: Published | null,
  snapshot: Snapshot,
  freshness: Freshness,
): Published {
  if (previous === null) {
    return { snapshot, staleRepositories: [] };
  }
  const previousByName = new Map(
    previous.snapshot.repositories.map((repository) => [nameKey(repository.fullName), repository]),
  );
  const previousStale = new Map(
    previous.staleRepositories.map((stale) => [nameKey(stale.fullName), stale.lastRefreshedAt]),
  );
  const lastRefreshed = (fullName: string): string =>
    previousStale.get(nameKey(fullName)) ?? previous.snapshot.generatedAt;

  const stale: StaleRepository[] = [];
  const repositories: RepositoryView[] = snapshot.repositories.map((repository) => {
    const before = previousByName.get(nameKey(repository.fullName));
    const kept = before === undefined ? [] : keptLines(before, repository, freshness);
    if (kept.length === 0) {
      return repository;
    }
    stale.push({
      fullName: repository.fullName,
      lastRefreshedAt: lastRefreshed(repository.fullName),
      lines: kept.map((line) => line.key),
    });
    const lines = [...repository.lines, ...kept].sort(compareLines);
    return { ...repository, lines, active: lines.some((line) => line.active) };
  });

  const present = new Set(snapshot.repositories.map((repository) => nameKey(repository.fullName)));
  for (const [key, repository] of previousByName) {
    if (!present.has(key) && isKept(key, repository, freshness)) {
      repositories.push(repository);
      stale.push({
        fullName: repository.fullName,
        lastRefreshedAt: lastRefreshed(repository.fullName),
        lines: null,
      });
    }
  }

  if (stale.length === 0) {
    return { snapshot, staleRepositories: [] };
  }
  return {
    snapshot: { ...snapshot, repositories: repositories.sort(compareRepositories) },
    staleRepositories: stale.sort((a, b) => nameKey(a.fullName).localeCompare(nameKey(b.fullName))),
  };
}

/** Whether a repository missing from the collection keeps its previous state. */
function isKept(key: string, repository: RepositoryView, freshness: Freshness): boolean {
  if (freshness.gone.has(key)) {
    return false;
  }
  return (
    freshness.notRefreshed.has(key) ||
    (repository.reasons.includes('own') && !freshness.ownRepositoriesComplete) ||
    (repository.reasons.includes('my_pull_request') && !freshness.myPullRequestsComplete)
  );
}

/** Pull request lines of `before` missing from `now` that must be kept (see {@link carryOver}). */
function keptLines(before: RepositoryView, now: RepositoryView, freshness: Freshness): LineView[] {
  const onlyForPullRequests = now.reasons.every((reason) => reason === 'my_pull_request');
  if (!onlyForPullRequests || freshness.myPullRequestsComplete) {
    return [];
  }
  const keys = new Set(now.lines.map((line) => line.key));
  return before.lines.filter((line) => line.kind === 'pull_request' && !keys.has(line.key));
}

function isPermanentFailure(problem: Problem): problem is Extract<Problem, { kind: 'repository' }> {
  return (
    problem.kind === 'repository' &&
    problem.httpStatus !== null &&
    PERMANENT_FAILURES.has(problem.httpStatus)
  );
}
