import type { Config } from './config.ts';
import type { WatchReason } from './inputs.ts';
import { nameKey } from './repository-name.ts';

/** A repository owned by the viewer, as listed by GitHub. */
export interface OwnRepositoryInput {
  /** `full_name`. */
  readonly fullName: string;
  /** `pushed_at`: last push to any branch; null for an empty repository. */
  readonly pushedAt: string | null;
}

/** What the GitHub client knows before deciding which repositories to poll. */
export interface WatchListInput {
  /** The viewer's repositories. */
  readonly ownRepositories: readonly OwnRepositoryInput[];
  /** Repositories (`owner/name`) where the viewer has at least one open pull request. */
  readonly pullRequestRepositories: readonly string[];
}

/** A repository to poll, and why. */
export interface WatchedRepository {
  /** `owner/name`, with the casing of the first source that mentioned it. */
  readonly fullName: string;
  /** Never empty, in the order `own`, `maintained`, `my_pull_request`. */
  readonly reasons: readonly WatchReason[];
}

/**
 * Decides which repositories to poll: own repositories pushed to recently (if enabled), the
 * maintained ones, and those with the viewer's open pull requests (if enabled), minus the
 * excluded ones. Names are compared case-insensitively; the result is sorted by name.
 */
export function resolveWatchList(
  config: Config,
  input: WatchListInput,
  now: Date,
): WatchedRepository[] {
  const excluded = new Set(config.excludedRepositories.map(nameKey));
  const entries = new Map<string, { fullName: string; reasons: Set<WatchReason> }>();
  const add = (fullName: string, reason: WatchReason): void => {
    const key = nameKey(fullName);
    if (excluded.has(key)) {
      return;
    }
    const entry = entries.get(key) ?? { fullName, reasons: new Set<WatchReason>() };
    entry.reasons.add(reason);
    entries.set(key, entry);
  };

  if (config.includeOwnRepositories) {
    const days = config.ownRepositoriesPushedWithinDays;
    const pushedSince = days === null ? -Infinity : now.getTime() - days * 86_400_000;
    for (const repository of input.ownRepositories) {
      const pushedAt = repository.pushedAt === null ? -Infinity : Date.parse(repository.pushedAt);
      if (days === null || pushedAt >= pushedSince) {
        add(repository.fullName, 'own');
      }
    }
  }
  for (const fullName of config.maintainedRepositories) {
    add(fullName, 'maintained');
  }
  if (config.includeMyPullRequests) {
    for (const fullName of input.pullRequestRepositories) {
      add(fullName, 'my_pull_request');
    }
  }

  const order: readonly WatchReason[] = ['own', 'maintained', 'my_pull_request'];
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({
      fullName: entry.fullName,
      reasons: order.filter((reason) => entry.reasons.has(reason)),
    }));
}
