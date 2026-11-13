import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, formatConfigIssues, parseConfig, type Config } from '../core/config.ts';
import type { Log } from './log.ts';
import type { ConfigStatus } from './payload.ts';

/** Environment variable overriding the path of the configuration file. */
export const CONFIG_PATH_VARIABLE = 'GITHUB_ACTION_VIEWER_CONFIG';

/** Quiet time after the last change event before the file is read again. */
export const RELOAD_DEBOUNCE_MS = 200;

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
  readonly debounceMs?: number;
}

/**
 * The configuration file, kept up to date: {@link watch} re-reads it whenever it changes, so that
 * edits apply without a restart. A missing file means the defaults; an invalid file keeps the last
 * valid configuration (the defaults if there never was one) and is reported through
 * {@link status}, for the page.
 */
export class ConfigFile {
  readonly path: string;
  readonly #options: ConfigFileOptions;
  #config: Config = DEFAULT_CONFIG;
  #status: ConfigStatus = { state: 'missing', problems: null, fallback: null };
  /** Whether a valid file was ever read: what an invalid file falls back to. */
  #hadValid = false;
  /** What the last read found, to ignore events that did not change anything; null before. */
  #lastRead: string | null = null;
  #watcher: FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #reloading: Promise<void> = Promise.resolve();

  constructor(path: string, options: ConfigFileOptions) {
    this.path = path;
    this.#options = options;
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
    await this.#reload();
  }

  /**
   * Watches the file for changes. The directory is watched rather than the file, because editors
   * save by writing a new file and renaming it over the old one, which ends a watch on the file
   * itself; bursts of events are debounced.
   */
  watch(): void {
    if (this.#watcher !== null) {
      return;
    }
    const name = basename(this.path);
    try {
      this.#watcher = watch(dirname(this.path), { persistent: false }, (_event, filename) => {
        if (filename === null || filename === name) {
          this.#scheduleReload();
        }
      });
      this.#watcher.on('error', (error) => {
        this.#options.log(
          `Stopped watching the configuration (${error.message}); restart to apply changes.`,
        );
        this.close();
      });
    } catch (error) {
      this.#options.log(
        `Cannot watch ${this.path} (${(error as Error).message}); restart to apply changes.`,
      );
    }
  }

  /** Stops watching. */
  close(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
  }

  /** Resolves once pending reloads are done (for tests). */
  async settled(): Promise<void> {
    await this.#reloading;
  }

  #scheduleReload(): void {
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
    }
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      // Reloads run one after the other, so that an older read never wins over a newer one.
      this.#reloading = this.#reloading.then(() => this.#reload());
    }, this.#options.debounceMs ?? RELOAD_DEBOUNCE_MS);
  }

  async #reload(): Promise<void> {
    const read = await readConfigFile(this.path);
    const found =
      read.kind === 'missing'
        ? 'missing'
        : read.kind === 'ok'
          ? `ok:${read.text}`
          : `invalid:${read.text ?? read.problems}`;
    if (found === this.#lastRead) {
      return;
    }
    const first = this.#lastRead === null;
    this.#lastRead = found;

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

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
