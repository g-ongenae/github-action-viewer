import { isRepositoryName, nameKey } from './repository-name.ts';

/** The user's configuration (`config.json`), validated and with defaults applied. */
export interface Config {
  /** Repositories watched in addition to the viewer's own (`owner/name`), without duplicates. */
  readonly maintainedRepositories: readonly string[];
  /** Repositories never shown, whatever the reason they would be (`owner/name`). */
  readonly excludedRepositories: readonly string[];
  /** Whether repositories owned by the viewer are watched. */
  readonly includeOwnRepositories: boolean;
  /**
   * Only watch own repositories pushed to within this many days, to avoid polling dormant ones;
   * null watches all of them.
   */
  readonly ownRepositoriesPushedWithinDays: number | null;
  /** Whether repositories where the viewer has an open pull request are watched. */
  readonly includeMyPullRequests: boolean;
  /** How long a finished run of another branch or someone else's pull request stays shown. */
  readonly recentWindowHours: number;
  /** Time between two polls of GitHub, in seconds. */
  readonly pollIntervalSeconds: number;
  /** Port of the local server. */
  readonly port: number;
}

/** Smallest accepted poll interval: polling faster burns the API quota for little benefit. */
export const MIN_POLL_INTERVAL_SECONDS = 10;

/** Largest accepted poll interval: an hour is already far from real time. */
export const MAX_POLL_INTERVAL_SECONDS = 3600;

export const DEFAULT_CONFIG: Config = {
  maintainedRepositories: [],
  excludedRepositories: [],
  includeOwnRepositories: true,
  ownRepositoriesPushedWithinDays: 30,
  includeMyPullRequests: true,
  recentWindowHours: 24,
  pollIntervalSeconds: 15,
  port: 4680,
};

/** One problem in a configuration: which key, and what is wrong with it. */
export interface ConfigIssue {
  /** Path of the offending value, e.g. `port` or `maintainedRepositories[2]`; `` for the root. */
  readonly path: string;
  /** What was expected and what was found. */
  readonly message: string;
}

export type ParseConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * Validates a parsed `config.json` and applies the defaults. Reports every problem at once,
 * including unknown keys (almost always typos).
 */
export function parseConfig(value: unknown): ParseConfigResult {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      issues: [{ path: '', message: `expected an object, got ${describe(value)}` }],
    };
  }

  const issues: ConfigIssue[] = [];
  const reader = new FieldReader(value, issues);
  const config: Config = {
    maintainedRepositories: reader.repositories('maintainedRepositories'),
    excludedRepositories: reader.repositories('excludedRepositories'),
    includeOwnRepositories: reader.boolean('includeOwnRepositories'),
    ownRepositoriesPushedWithinDays: reader.nullableNumber('ownRepositoriesPushedWithinDays', {
      integer: true,
      min: 1,
    }),
    includeMyPullRequests: reader.boolean('includeMyPullRequests'),
    recentWindowHours: reader.number('recentWindowHours', { integer: false, min: 0 }),
    pollIntervalSeconds: reader.number('pollIntervalSeconds', {
      integer: true,
      min: MIN_POLL_INTERVAL_SECONDS,
      max: MAX_POLL_INTERVAL_SECONDS,
    }),
    port: reader.number('port', { integer: true, min: 1, max: 65_535 }),
  };

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) {
      issues.push({
        path: key,
        message: `unknown key; expected one of ${Object.keys(DEFAULT_CONFIG).join(', ')}`,
      });
    }
  }

  return issues.length === 0 ? { ok: true, config } : { ok: false, issues };
}

/** Formats issues for a human, one per line: `port: expected an integer…, got "80"`. */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  return issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .join('\n');
}

interface NumberRule {
  readonly integer: boolean;
  readonly min: number;
  readonly max?: number;
}

/**
 * Reads the keys of the raw object, recording an issue and returning the default for each invalid
 * value, so that validation carries on and reports everything.
 */
class FieldReader {
  readonly #raw: Readonly<Record<string, unknown>>;
  readonly #issues: ConfigIssue[];

  constructor(raw: Readonly<Record<string, unknown>>, issues: ConfigIssue[]) {
    this.#raw = raw;
    this.#issues = issues;
  }

  boolean(key: KeysOfType<boolean>): boolean {
    const value = this.#raw[key];
    if (value === undefined) {
      return DEFAULT_CONFIG[key];
    }
    if (typeof value !== 'boolean') {
      return this.#fail(key, `expected true or false, got ${describe(value)}`, DEFAULT_CONFIG[key]);
    }
    return value;
  }

  number(key: KeysOfType<number>, rule: NumberRule): number {
    const value = this.#raw[key];
    if (value === undefined) {
      return DEFAULT_CONFIG[key];
    }
    return this.#checkNumber(key, value, rule, DEFAULT_CONFIG[key]);
  }

  nullableNumber(key: KeysOfType<number | null>, rule: NumberRule): number | null {
    const value = this.#raw[key];
    if (value === undefined) {
      return DEFAULT_CONFIG[key];
    }
    if (value === null) {
      return null;
    }
    return this.#checkNumber(key, value, rule, DEFAULT_CONFIG[key], ' or null');
  }

  /** A list of `owner/name` strings; duplicates (compared case-insensitively) are dropped. */
  repositories(key: KeysOfType<readonly string[]>): readonly string[] {
    const value = this.#raw[key];
    if (value === undefined) {
      return DEFAULT_CONFIG[key];
    }
    if (!Array.isArray(value)) {
      return this.#fail(
        key,
        `expected a list of "owner/name" strings, got ${describe(value)}`,
        DEFAULT_CONFIG[key],
      );
    }
    const seen = new Set<string>();
    const names: string[] = [];
    value.forEach((item: unknown, index) => {
      if (typeof item !== 'string' || !isRepositoryName(item)) {
        this.#issues.push({
          path: `${key}[${String(index)}]`,
          message: `expected a repository as "owner/name", got ${describe(item)}`,
        });
      } else if (!seen.has(nameKey(item))) {
        seen.add(nameKey(item));
        names.push(item);
      }
    });
    return names;
  }

  #checkNumber<T>(
    key: string,
    value: unknown,
    rule: NumberRule,
    fallback: T,
    orNull = '',
  ): number | T {
    const kind = rule.integer ? 'an integer' : 'a number';
    const range =
      rule.max === undefined
        ? `>= ${String(rule.min)}`
        : `between ${String(rule.min)} and ${String(rule.max)}`;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (rule.integer && !Number.isInteger(value)) ||
      value < rule.min ||
      (rule.max !== undefined && value > rule.max)
    ) {
      return this.#fail(
        key,
        `expected ${kind} ${range}${orNull}, got ${describe(value)}`,
        fallback,
      );
    }
    return value;
  }

  #fail<T>(path: string, message: string, fallback: T): T {
    this.#issues.push({ path, message });
    return fallback;
  }
}

/** Keys of {@link Config} whose values have type `T`. */
type KeysOfType<T> = {
  [K in keyof Config]: Config[K] extends T ? (T extends Config[K] ? K : never) : never;
}[keyof Config];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short description of a found value for error messages: `"80"`, `12.5`, `a list`, `null`. */
function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (isPlainObject(value)) {
    return 'an object';
  }
  if (value === undefined) {
    return 'nothing';
  }
  return JSON.stringify(value);
}
