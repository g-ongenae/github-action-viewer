import { compareRepositories } from '../core/build-snapshot.ts';
import { nameKey } from '../core/repository-name.ts';
import type { RepositoryView, Snapshot } from '../core/snapshot.ts';
import type { CollectionResult } from '../github/collect.ts';
import type { StaleRepository } from './payload.ts';

/** What the page shows: a snapshot, and which of its repositories come from earlier collections. */
export interface Published {
  readonly snapshot: Snapshot;
  readonly staleRepositories: readonly StaleRepository[];
}

/**
 * Merges a collection into what the page showed, repository by repository (names compared
 * case-insensitively), so that nothing disappears for lack of data:
 *
 * 1. in `refreshed`: the new view, which is authoritative; absent from the new snapshot means it
 *    has no line left;
 * 2. in `notRefreshed` (could not be read, cut off by a rate limit, or possibly incomplete): the
 *    previous view if there was one, the new one otherwise;
 * 3. in neither (no longer in the watch list): dropped if the watch list was read completely
 *    (`watchListComplete`), the previous view kept otherwise.
 *
 * Views kept from before are listed in `staleRepositories`, with the time of their last refresh.
 */
export function carryOver(previous: Published | null, result: CollectionResult): Published {
  const { snapshot } = result;
  if (previous === null) {
    return { snapshot, staleRepositories: [] };
  }

  const refreshed = new Set(result.refreshed.map(nameKey));
  const notRefreshed = new Set(result.notRefreshed.map(nameKey));
  const previousStale = new Map(
    previous.staleRepositories.map((stale) => [nameKey(stale.fullName), stale.lastRefreshedAt]),
  );
  const fresh = new Map(
    snapshot.repositories.map((repository) => [nameKey(repository.fullName), repository]),
  );

  const kept: RepositoryView[] = [];
  for (const repository of previous.snapshot.repositories) {
    const key = nameKey(repository.fullName);
    const keep = !refreshed.has(key) && (notRefreshed.has(key) || !result.watchListComplete);
    if (keep) {
      kept.push(repository);
      fresh.delete(key);
    }
  }
  if (kept.length === 0) {
    return { snapshot, staleRepositories: [] };
  }

  return {
    snapshot: {
      ...snapshot,
      repositories: [...fresh.values(), ...kept].sort(compareRepositories),
    },
    staleRepositories: kept
      .map((repository) => ({
        fullName: repository.fullName,
        lastRefreshedAt:
          previousStale.get(nameKey(repository.fullName)) ?? previous.snapshot.generatedAt,
      }))
      .sort((a, b) => nameKey(a.fullName).localeCompare(nameKey(b.fullName))),
  };
}
