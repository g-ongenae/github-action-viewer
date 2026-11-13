import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, formatConfigIssues, parseConfig, type Config } from '../core/config.ts';
import type { Log } from './log.ts';
import { systemClock, type Clock } from './poller.ts';
import type { ConfigStatus } from './payload.ts';

/** Environment variable overriding the path of the configuration file. */
export const CONFIG_PATH_VARIABLE = 'GITHUB_ACTION_VIEWER_CONFIG';

/** Time between two reads of the configuration file while watching it. */
export const CONFIG_POLL_MS = 1000;

/** The system clock, with timers that do not keep the process alive. */
const unrefClock: Clock = {
  ...systemClock,
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
};

/**
 * Path of the configuration file: `explicit` (a command-line flag) if given, then
 * `$GITHUB_ACTION_VIEWER_CONFIG`, then `config.json` at the repository root. Relative paths are
 * resolved against the current directory.
 */
export function configPath(
  explicit?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // An empty variable counts as unset.
  const fromEnv = env[CONFIG_PATH_VARIABLE];
  const chosen = explicit ?? (fromEnv === '' ? undefined : fromEnv);
  return chosen === undefined
    ? fileURLToPath(new URL('../../config.json', import.meta.url))
    : resolve(chosen);
}

/** The outcome of reading the configuration file. */
export type ConfigRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly config: Config; readonly text: string }
  /** `problems`: one per line, for a human. */
  | { readonly kind: 'invalid'; readonly problems: string; readonly text: string | null };

/** Reads and validates the configuration file. Never throws. */
export async function readConfigFile(path: string): Promise<ConfigRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return {
      kind: 'invalid',
      problems: `the file could not be read (${code ?? 'unknown error'})`,
      text: null,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: 'invalid', problems: `not valid JSON: ${(error as Error).message}`, text };
  }
  const result = parseConfig(value);
  return result.ok
    ? { kind: 'ok', config: result.config, text }
    : { kind: 'invalid', problems: formatConfigIssues(result.issues), text };
}

export interface ConfigFileOptions {
  readonly log: Log;
  /** Called after a reload changed the configuration in use or its status. */
  readonly onChange?: (change: { readonly configChanged: boolean }) => void;
  /** Time between two reads while watching; default {@link CONFIG_POLL_MS}. */
  readonly pollMs?: number;
  /** Timers for polling; the default ones do not keep the process alive. */
  readonly clock?: Clock;
}

/**
 * The configuration file, kept up to date: {@link watch} re-reads it whenever it changes, so that
 * edits apply without a restart. A missing file means the defaults; an invalid file keeps the last
 * valid configuration (the defaults if there never was one) and is reported through
 * {@link status}, for the page.
 */
/**
 * The configuration file, kept up to date: {@link watch} re-reads it every second or so, so that
 * edits apply without a restart. A missing file means the defaults; an invalid file keeps the last
 * valid configuration (the defaults if there never was one) and is reported through
 * {@link status}, for the page.
 *
 * Watching is done by reading the path again rather than with `fs.watch`: reading follows
 * symbolic links (a config kept in a dotfiles repository), survives editors that save by renaming
 * a new file over the old one, deletion and re-creation, and works when neither the file nor its
 * directory exists yet. The file is tiny, so the cost is negligible.
 */
export class ConfigFile {
  readonly path: string;
  readonly #options: ConfigFileOptions;
  readonly #clock: Clock;
  #config: Config = DEFAULT_CONFIG;
  #status: ConfigStatus = { state: 'missing', problems: null, fallback: null };
  /** Whether a valid file was ever read: what an invalid file falls back to. */
  #hadValid = false;
  /** What the applied read found (see `describe`); null before the first read. */
  #applied: string | null = null;
  /** A different read seen once: applied if the next poll sees it again. */
  #pending: string | null = null;
  #timer: unknown = null;
  #watching = false;
  #polling: Promise<void> = Promise.resolve();

  constructor(path: string, options: ConfigFileOptions) {
    this.path = path;
    this.#options = options;
    this.#clock = options.clock ?? unrefClock;
  }

  /** The configuration in use. */
  get config(): Config {
    return this.#config;
  }

  get status(): ConfigStatus {
    return this.#status;
  }

  /** Reads the file and logs what was found. */
  async load(): Promise<void> {
    const read = await readConfigFile(this.path);
    this.#apply(read, describe(read));
  }

  /**
   * Re-reads the file periodically. A change is applied once two reads in a row agree, which
   * filters out most files caught while an editor is writing them. It is a debounce, not a
   * guarantee: a half-written file that stays unchanged across two reads is still reported (or
   * applied, if it happens to be valid). Editors that save atomically never expose one.
   */
  watch(): void {
    if (this.#watching) {
      return;
    }
    this.#watching = true;
    this.#arm();
  }

  /** Stops watching. */
  close(): void {
    this.#watching = false;
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Resolves once the running poll, if any, is done (for tests). */
  async settled(): Promise<void> {
    await this.#polling;
  }

  #arm(): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#polling = this.#poll();
    }, this.#options.pollMs ?? CONFIG_POLL_MS);
  }

  async #poll(): Promise<void> {
    const read = await readConfigFile(this.path);
    if (!this.#watching) {
      return;
    }
    const found = describe(read);
    if (found === this.#applied) {
      this.#pending = null;
    } else if (found === this.#pending) {
      this.#pending = null;
      this.#apply(read, found);
    } else {
      this.#pending = found;
    }
    this.#arm();
  }

  #apply(read: ConfigRead, found: string): void {
    const first = this.#applied === null;
    this.#applied = found;
    const previousConfig = this.#config;
    const { log } = this.#options;
    switch (read.kind) {
      case 'missing':
        this.#config = DEFAULT_CONFIG;
        this.#status = { state: 'missing', problems: null, fallback: null };
        log(`No configuration file: using the defaults. Create ${this.path} to change them.`);
        break;
      case 'ok':
        this.#config = read.config;
        this.#hadValid = true;
        this.#status = { state: 'ok', problems: null, fallback: null };
        log(`${first ? 'Loaded' : 'Reloaded'} the configuration from ${this.path}.`);
        break;
      case 'invalid': {
        const fallback = this.#hadValid ? 'last_valid' : 'defaults';
        this.#status = { state: 'invalid', problems: read.problems, fallback };
        log(
          `Invalid configuration in ${this.path}; using the ${fallback === 'last_valid' ? 'last valid configuration' : 'defaults'}:\n${indent(read.problems)}`,
        );
        break;
      }
    }

    if (!first) {
      this.#options.onChange?.({
        configChanged: JSON.stringify(previousConfig) !== JSON.stringify(this.#config),
      });
    }
  }
}

/** What a read found, as a string that differs whenever the outcome would. */
function describe(read: ConfigRead): string {
  switch (read.kind) {
    case 'missing':
      return 'missing';
    case 'ok':
      return `ok:${read.text}`;
    case 'invalid':
      return `invalid:${read.text ?? read.problems}`;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
