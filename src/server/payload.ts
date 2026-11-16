// The HTTP API contract: what `GET /api/snapshot` and `GET /api/events` send to the page, and the
// answers of the routes that edit the list of maintained repositories.
//
// This module holds types only and imports nothing but types, so that the browser code can use
// it with `import type` without pulling any Node module into the bundle. Like the core snapshot,
// everything is plain JSON: dates are ISO 8601 strings and absent values are `null`.

import type { Snapshot } from '../core/snapshot.ts';

/** Everything the page shows: the data, and how fresh and trustworthy it is. */
export interface PagePayload {
  /**
   * The latest page, with repositories carried over from earlier collections when they could not
   * be refreshed (see {@link ServerStatus.staleRepositories}); null until a collection succeeds.
   */
  readonly snapshot: Snapshot | null;
  readonly status: ServerStatus;
}

/** State of the server around the snapshot. */
export interface ServerStatus {
  /** When the latest collection attempt ended, successful or not; null before the first one. */
  readonly lastCheckedAt: string | null;
  /** When the latest successful collection ended; null before the first one. */
  readonly lastSuccessAt: string | null;
  /** When the next collection is due; null once the server is stopping. */
  readonly nextPollAt: string | null;
  /** Set while collections fail: the whole snapshot is the last good one, not current data. */
  readonly stale: Staleness | null;
  /**
   * Repositories that the latest collection could not refresh (rate limit, network or server
   * error, incomplete list): they show their state from an earlier collection. Sorted by name.
   */
  readonly staleRepositories: readonly StaleRepository[];
  readonly pollInterval: PollInterval;
  readonly rateLimits: RateLimits;
  readonly config: ConfigStatus;
}

/** Why the whole snapshot is out of date. */
export interface Staleness {
  /**
   * `rate_limited`: GitHub refused the collection until `rateLimits.retryAt`;
   * `collection_failed`: anything else (network down, token expired or revoked, GitHub error).
   */
  readonly reason: 'rate_limited' | 'collection_failed';
  /** Short, human-readable description of the latest failure. */
  readonly message: string;
  /** When collections started failing. */
  readonly since: string;
}

/** A repository shown with the state it had when it was last refreshed. */
export interface StaleRepository {
  /** `owner/name`, as in the snapshot. */
  readonly fullName: string;
  /** When its data was collected. */
  readonly lastRefreshedAt: string;
}

/** Time between two collections. */
export interface PollInterval {
  /** `pollIntervalSeconds` from the configuration. */
  readonly baseSeconds: number;
  /** The delay actually used before the next collection (rounded up). */
  readonly currentSeconds: number;
  /**
   * `base`: the configured interval;
   * `budget`: stretched so that the API quota lasts until it resets, keeping a reserve;
   * `rate_limited`: waiting for a GitHub rate limit to lift;
   * `backoff`: collections fail, retrying less and less often.
   */
  readonly reason: 'base' | 'budget' | 'rate_limited' | 'backoff';
}

/** GitHub API quotas, as of the latest response. */
export interface RateLimits {
  /** The quota that collections spend (5,000 requests per hour for a user token). */
  readonly core: Quota | null;
  /** The search quota (30 requests per minute), spent once per collection. */
  readonly search: Quota | null;
  /** Set while a rate limit is in effect: nothing is sent to GitHub before this time. */
  readonly retryAt: string | null;
}

export interface Quota {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

/** The configuration file, as last read. */
export interface ConfigStatus {
  /**
   * `ok`: read and valid; `missing`: there is no file, the defaults apply; `invalid`: the file
   * could not be used (unreadable, not JSON, or wrong values) and `fallback` applies.
   */
  readonly state: 'ok' | 'missing' | 'invalid';
  /** For `invalid`: what is wrong, one problem per line. Null otherwise. */
  readonly problems: string | null;
  /** For `invalid`: the configuration still in use. Null otherwise. */
  readonly fallback: 'last_valid' | 'defaults' | null;
  /** `maintainedRepositories` of the configuration in use (`owner/name`), in the file's order. */
  readonly maintainedRepositories: readonly string[];
  /**
   * Whether the page may add and remove maintained repositories:
   * - `on`: yes;
   * - `blocked`: not while the file has problems (the server will not rewrite such a file);
   * - `off`: never (the server runs with `--read-only`).
   */
  readonly editing: 'on' | 'blocked' | 'off';
}

/**
 * `GET /api/repositories`: the repositories the page offers to add. It is not exhaustive (any
 * repository the token can read can be added by name), only what GitHub lists for the user.
 */
export interface RepositoryCatalogue {
  /**
   * Repositories the user owns, collaborates on or reaches through an organization, public and
   * private, that are neither archived nor disabled; most recently pushed first.
   */
  readonly repositories: readonly CatalogueRepository[];
  /** False when the list was cut short (GitHub failed part-way, or it has too many pages). */
  readonly complete: boolean;
}

export interface CatalogueRepository {
  /** `owner/name`, with GitHub's casing. */
  readonly fullName: string;
  readonly private: boolean;
}

/** Answer of `PUT` and `DELETE /api/maintained-repositories/{owner}/{name}`. */
export interface WatchListChange {
  /** The repository, under GitHub's current name when it was looked up (`PUT`). */
  readonly repository: string;
  /** False when there was nothing to do: already in the list (`PUT`) or not in it (`DELETE`). */
  readonly changed: boolean;
  /** `maintainedRepositories` after the change. */
  readonly maintainedRepositories: readonly string[];
}

/** Body of an error answer of the three routes above; other routes answer in plain text. */
export interface ApiError {
  /** What went wrong, for the reader. */
  readonly error: string;
}

/**
 * Sent on the event stream between payloads: proves the connection is alive, and carries the
 * fields that change on every collection (when the data was last checked, the next poll, quotas)
 * without re-sending a payload whose content did not change.
 */
export interface Heartbeat {
  /** Server clock when the heartbeat was sent. */
  readonly serverTime: string;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextPollAt: string | null;
  readonly pollInterval: PollInterval;
  readonly rateLimits: RateLimits;
}

/** Names of the Server-Sent Events of `GET /api/events`. */
export type EventName =
  /** `data` is a {@link PagePayload}; sent on connection and whenever the content changes. */
  | 'payload'
  /** `data` is a {@link Heartbeat}; sent after each collection that changed nothing, and periodically. */
  | 'heartbeat';
