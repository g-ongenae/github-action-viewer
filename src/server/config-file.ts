import { chmod, mkdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, formatConfigIssues, parseConfig, type Config } from '../core/config.ts';
import type { Log } from './log.ts';
import { systemClock, type Clock } from './poller.ts';
import type { ConfigStatus } from './payload.ts';

/** Environment variable overriding the path of the configuration file. */
export const CONFIG_PATH_VARIABLE = 'GITHUB_ACTION_VIEWER_CONFIG';

/** Times an update starts over because the file changed while it was being saved. */
export const UPDATE_ATTEMPTS = 3;

/** Symbolic links followed from the configuration path to the file it stands for. */
const MAX_LINKS = 16;

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

/**
 * Changes to make to the file: the keys to set, given the configuration the file holds right now
 * (the defaults for a missing file); null to leave the file alone.
 */
export type ConfigEdit = (current: Config) => Partial<Config> | null;

/** The outcome of {@link ConfigFile.update}. */
export type ConfigUpdate =
  /** The file was rewritten and `config` applies from now on. */
  | { readonly kind: 'saved'; readonly config: Config }
  /** The edit had nothing to change; `config` is what the file holds. */
  | { readonly kind: 'unchanged'; readonly config: Config }
  | {
      readonly kind: 'refused';
      /**
       * `read_only`: the file is never written (see {@link ConfigFileOptions.readOnly});
       * `invalid`: the file has problems, and is left for its owner to fix;
       * `unwritable`: writing failed, or the file kept changing under the server.
       */
      readonly reason: 'read_only' | 'invalid' | 'unwritable';
      /** For a human; `invalid` lists the problems, one per line. */
      readonly message: string;
    };

export interface ConfigFileOptions {
  readonly log: Log;
  /** Never write the file: {@link ConfigFile.update} is refused. */
  readonly readOnly?: boolean;
  /** Called after a reload changed the configuration in use or its status. */
  readonly onChange?: (change: { readonly configChanged: boolean }) => void;
  /** Time between two reads while watching; default {@link CONFIG_POLL_MS}. */
  readonly pollMs?: number;
  /** Timers for polling; the default ones do not keep the process alive. */
  readonly clock?: Clock;
}

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
 *
 * {@link update} is the only way the server writes the file, for the page's edits.
 */
export class ConfigFile {
  readonly path: string;
  readonly #options: ConfigFileOptions;
  readonly #clock: Clock;
  #config: Config = DEFAULT_CONFIG;
  #status: FileStatus = { state: 'missing', problems: null, fallback: null };
  /** Whether a valid file was ever read: what an invalid file falls back to. */
  #hadValid = false;
  /** What the applied read found (see `describe`); null before the first read. */
  #applied: string | null = null;
  /** A different read seen once: applied if the next poll sees it again. */
  #pending: string | null = null;
  #timer: unknown = null;
  #watching = false;
  #polling: Promise<void> = Promise.resolve();
  /** The latest {@link update}: the next one waits for it, so that no edit is lost. */
  #updating: Promise<unknown> = Promise.resolve();

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
    return {
      ...this.#status,
      maintainedRepositories: this.#config.maintainedRepositories,
      editing:
        this.#options.readOnly === true
          ? 'off'
          : this.#status.state === 'invalid'
            ? 'blocked'
            : 'on',
    };
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

  /**
   * Edits the file and applies the result at once, without waiting for the next read. The edit is
   * computed from the file as it is now, not from the configuration in use, so that a change
   * saved a moment ago is never overwritten; only the keys it returns are set, the others (and
   * their order) are kept. The file is rewritten as indented JSON. Updates run one at a time.
   *
   * A file saved by someone else while the update is under way is noticed right before the
   * replacement, and the update starts over from it (`edit` is then called again). What is left
   * is the instant of the replacement itself: nothing coordinates the server with an editor.
   */
  update(edit: ConfigEdit): Promise<ConfigUpdate> {
    const update = this.#updating.then(() => this.#update(edit));
    this.#updating = update.catch(() => undefined);
    return update;
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

  async #update(edit: ConfigEdit): Promise<ConfigUpdate> {
    if (this.#options.readOnly === true) {
      return {
        kind: 'refused',
        reason: 'read_only',
        message: 'The viewer runs in read-only mode: the configuration file is not changed.',
      };
    }
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt += 1) {
      const read = await readConfigFile(this.path);
      if (read.kind === 'invalid') {
        return {
          kind: 'refused',
          reason: 'invalid',
          message: `The configuration file has problems; fix them first:\n${read.problems}`,
        };
      }
      const current = read.kind === 'ok' ? read.config : DEFAULT_CONFIG;
      const changes = edit(current);
      if (changes === null) {
        return { kind: 'unchanged', config: current };
      }
      // What the file holds, not `current`: defaults are not written for the keys it leaves out.
      const next = {
        ...(read.kind === 'ok' ? (JSON.parse(read.text) as Record<string, unknown>) : {}),
        ...changes,
      };
      const parsed = parseConfig(next);
      if (!parsed.ok) {
        return { kind: 'refused', reason: 'invalid', message: formatConfigIssues(parsed.issues) };
      }
      const text = `${JSON.stringify(next, null, 2)}\n`;
      let replaced: boolean;
      try {
        replaced = await replaceFile(
          this.path,
          text,
          async () => describe(await readConfigFile(this.path)) === describe(read),
        );
      } catch (error) {
        return {
          kind: 'refused',
          reason: 'unwritable',
          message: `The configuration file could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
        };
      }
      if (replaced) {
        const saved: ConfigRead = { kind: 'ok', config: parsed.config, text };
        this.#pending = null;
        this.#apply(saved, describe(saved), 'Saved');
        return { kind: 'saved', config: parsed.config };
      }
    }
    return {
      kind: 'refused',
      reason: 'unwritable',
      message: 'The configuration file kept changing while it was being saved: try again.',
    };
  }

  #apply(read: ConfigRead, found: string, verb?: string): void {
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
        log(
          verb === undefined
            ? `${first ? 'Loaded' : 'Reloaded'} the configuration from ${this.path}.`
            : `${verb} the configuration to ${this.path}.`,
        );
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

/** The part of the status that comes from reading the file. */
type FileStatus = Pick<ConfigStatus, 'state' | 'problems' | 'fallback'>;

/**
 * Replaces the content of `path` in one step (a temporary file renamed over it), so that neither
 * a reader nor a crash ever finds half a file. Symbolic links are followed and kept, even to a
 * file that does not exist yet: the file they lead to is the one written, keeping its
 * permissions when it exists. Missing directories are created.
 *
 * `unchanged` is asked right before the replacement: when it answers false, nothing is replaced
 * and the result is false.
 */
async function replaceFile(
  path: string,
  text: string,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  const target = await writeTarget(path);
  let mode: number | null = null;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await mkdir(dirname(target), { recursive: true });
  }
  const temporary = `${target}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporary, text);
    if (mode !== null) {
      // Set after creation: a mode given at creation is cut down by the process's umask.
      await chmod(temporary, mode);
    }
    if (!(await unchanged())) {
      await rm(temporary, { force: true });
      return false;
    }
    await rename(temporary, target);
    return true;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The file that writing to `path` reaches: `path` itself, or where its symbolic links lead. */
async function writeTarget(path: string): Promise<string> {
  let target = path;
  for (let followed = 0; followed < MAX_LINKS; followed += 1) {
    let link: string;
    try {
      link = await readlink(target);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      // Not a link, or nothing there yet: this is the file to write.
      if (code === 'EINVAL' || code === 'ENOENT') {
        return target;
      }
      throw error;
    }
    target = resolve(dirname(target), link);
  }
  throw Object.assign(new Error('Too many levels of symbolic links.'), { code: 'ELOOP' });
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
