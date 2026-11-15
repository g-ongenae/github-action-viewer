// The page's edits of the watch list: adding a repository to `maintainedRepositories` in the
// configuration file, removing one, and the list of repositories offered to add.

import type { Config } from '../core/config.ts';
import { isRepositoryName, sameName } from '../core/repository-name.ts';
import type { GitHubClient } from '../github/client.ts';
import {
  AccessDeniedError,
  GitHubError,
  NetworkError,
  NotFoundError,
  RateLimitError,
} from '../github/errors.ts';
import { listAccessibleRepositories, lookUpRepository } from '../github/repositories.ts';
import type { ConfigFile, ConfigUpdate } from './config-file.ts';
import type { RepositoryCatalogue, WatchListChange } from './payload.ts';

/** How long the list of repositories offered to add is served without asking GitHub again. */
export const CATALOGUE_TTL_MS = 60_000;

/** A refusal the reader can act on: sent to the page with this HTTP status and message. */
export class WatchListError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WatchListError';
    this.status = status;
  }
}

/**
 * What the HTTP server needs to let the page edit the watch list. Every method rejects with a
 * {@link WatchListError} for what the reader can act on, and with anything else for a bug.
 */
export interface WatchListEditor {
  /** The repositories offered to add. */
  catalogue(): Promise<RepositoryCatalogue>;
  /** Adds `repository` (`owner/name`) to the maintained repositories. */
  add(repository: string): Promise<WatchListChange>;
  /** Removes `repository` (`owner/name`) from the maintained repositories. */
  remove(repository: string): Promise<WatchListChange>;
}

export interface ConfigWatchListEditorOptions {
  readonly client: GitHubClient;
  readonly configFile: Pick<ConfigFile, 'update'>;
  /**
   * When the GitHub rate limit in effect lifts (milliseconds since the epoch), null without one:
   * nothing is sent to GitHub before that time.
   */
  readonly rateLimitedUntil?: () => number | null;
  /** Milliseconds since the epoch; defaults to the system clock. */
  readonly now?: () => number;
}

/**
 * Edits `maintainedRepositories` in the configuration file. The collection that follows a change
 * is not started here: the configuration file reports the change, like any other.
 */
export class ConfigWatchListEditor implements WatchListEditor {
  readonly #options: ConfigWatchListEditorOptions;
  readonly #now: () => number;
  #catalogue: { readonly value: RepositoryCatalogue; readonly at: number } | null = null;
  /** The request to GitHub under way, shared by everyone asking meanwhile. */
  #loading: Promise<RepositoryCatalogue> | null = null;

  constructor(options: ConfigWatchListEditorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * GitHub's list for the user, kept for {@link CATALOGUE_TTL_MS}. Asking again is free while it
   * has not changed (the client sends conditional requests).
   */
  catalogue(): Promise<RepositoryCatalogue> {
    const cached = this.#catalogue;
    if (cached !== null && this.#now() - cached.at < CATALOGUE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    this.#loading ??= this.#loadCatalogue().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #loadCatalogue(): Promise<RepositoryCatalogue> {
    this.#refuseWhileRateLimited();
    try {
      const value = await listAccessibleRepositories(this.#options.client);
      this.#catalogue = { value, at: this.#now() };
      return value;
    } catch (error) {
      throw this.#explained(error, 'Your repositories could not be listed');
    }
  }

  /**
   * Checks with GitHub that the token can read the repository, then lists it under its current
   * name. A repository that was excluded is no longer: adding it means wanting to see it.
   */
  async add(repository: string): Promise<WatchListChange> {
    requireRepositoryName(repository);
    this.#refuseWhileRateLimited();
    let current: string;
    try {
      current = (await lookUpRepository(this.#options.client, repository)).fullName;
    } catch (error) {
      throw this.#explained(error, `${repository} could not be checked`, repository);
    }
    // An old name still in the file counts: GitHub answers it with the same repository.
    const same = (name: string): boolean => sameName(name, current) || sameName(name, repository);
    return this.#update(current, (config) => {
      const listed = config.maintainedRepositories.some(same);
      const excluded = config.excludedRepositories.some(same);
      if (listed && !excluded) {
        return null;
      }
      return {
        ...(listed ? {} : { maintainedRepositories: [...config.maintainedRepositories, current] }),
        ...(excluded
          ? { excludedRepositories: config.excludedRepositories.filter((name) => !same(name)) }
          : {}),
      };
    });
  }

  /** Nothing is asked to GitHub: a repository that no longer exists can still be removed. */
  async remove(repository: string): Promise<WatchListChange> {
    requireRepositoryName(repository);
    return this.#update(repository, (config) =>
      config.maintainedRepositories.some((name) => sameName(name, repository))
        ? {
            maintainedRepositories: config.maintainedRepositories.filter(
              (name) => !sameName(name, repository),
            ),
          }
        : null,
    );
  }

  async #update(
    repository: string,
    edit: (config: Config) => Partial<Config> | null,
  ): Promise<WatchListChange> {
    const update: ConfigUpdate = await this.#options.configFile.update(edit);
    if (update.kind === 'refused') {
      throw new WatchListError(update.reason === 'unwritable' ? 500 : 409, update.message);
    }
    return {
      repository,
      changed: update.kind === 'saved',
      maintainedRepositories: update.config.maintainedRepositories,
    };
  }

  #refuseWhileRateLimited(): void {
    const until = this.#options.rateLimitedUntil?.() ?? null;
    if (until !== null && until > this.#now()) {
      throw new WatchListError(429, rateLimitMessage(until, this.#now()));
    }
  }

  /** A GitHub failure as a refusal the page can show; anything else is returned as it is. */
  #explained(error: unknown, what: string, repository?: string): unknown {
    if (!(error instanceof GitHubError)) {
      return error;
    }
    if (error instanceof RateLimitError) {
      return new WatchListError(429, rateLimitMessage(error.retryAt.getTime(), this.#now()));
    }
    if (error instanceof NotFoundError && repository !== undefined) {
      return new WatchListError(
        404,
        `${repository} was not found on GitHub, or the token cannot read it.`,
      );
    }
    if (error instanceof AccessDeniedError) {
      // GitHub's own words say what is missing (a scope, the organization's SSO authorization…).
      return new WatchListError(error.status === 401 ? 502 : 403, `${what}: ${error.message}`);
    }
    return new WatchListError(
      error instanceof NetworkError ? 504 : 502,
      `${what}: ${error.message}`,
    );
  }
}

function requireRepositoryName(repository: string): void {
  if (!isRepositoryName(repository)) {
    throw new WatchListError(400, 'Expected a repository as owner/name.');
  }
}

function rateLimitMessage(until: number, now: number): string {
  const minutes = Math.ceil((until - now) / 60_000);
  return `GitHub’s rate limit was reached: try again in ${minutes <= 1 ? 'a minute' : `${String(minutes)} minutes`}.`;
}
