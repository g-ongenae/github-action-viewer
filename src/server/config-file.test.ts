import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../core/config.ts';
import { ConfigFile, configPath, readConfigFile, type ConfigFileOptions } from './config-file.ts';
import type { Clock } from './poller.ts';

let dir: string;
let path: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gav-config-'));
  path = join(dir, 'config.json');
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const log = (line: string) => logs.push(line);

/** Writes the file the way editors do: a new file renamed over the old one. */
async function save(content: unknown): Promise<void> {
  const temporary = join(dir, 'config.json.swp');
  await writeFile(temporary, typeof content === 'string' ? content : JSON.stringify(content));
  await rename(temporary, path);
}

describe('configPath', () => {
  it('prefers the flag, then the environment variable, then the repository root', () => {
    expect(configPath('a.json', { GITHUB_ACTION_VIEWER_CONFIG: 'b.json' })).toBe(resolve('a.json'));
    expect(configPath(undefined, { GITHUB_ACTION_VIEWER_CONFIG: 'b.json' })).toBe(
      resolve('b.json'),
    );
    expect(configPath(undefined, { GITHUB_ACTION_VIEWER_CONFIG: '' })).toBe(
      resolve(import.meta.dirname, '../../config.json'),
    );
  });
});

describe('readConfigFile', () => {
  it('reports a missing, valid or invalid file', async () => {
    expect(await readConfigFile(path)).toEqual({ kind: 'missing' });
    await save({ pollIntervalSeconds: 30 });
    expect(await readConfigFile(path)).toMatchObject({
      kind: 'ok',
      config: { ...DEFAULT_CONFIG, pollIntervalSeconds: 30 },
    });
    await save('{ "port": ');
    expect(await readConfigFile(path)).toMatchObject({
      kind: 'invalid',
      problems: expect.stringMatching(/^not valid JSON: /) as string,
    });
    await save({ port: '80', pollIntervalSeconds: 1 });
    expect(await readConfigFile(path)).toMatchObject({
      kind: 'invalid',
      problems:
        'pollIntervalSeconds: expected an integer between 10 and 3600, got 1\nport: expected an integer between 1 and 65535, got "80"',
    });
    expect(await readConfigFile(dir)).toEqual({
      kind: 'invalid',
      problems: 'the file could not be read (EISDIR)',
      text: null,
    });
  });
});

describe('ConfigFile', () => {
  it('runs on the defaults when the file is missing, and says where to create it', async () => {
    const file = new ConfigFile(path, { log });
    await file.load();
    expect(file.config).toBe(DEFAULT_CONFIG);
    expect(file.status).toEqual({
      state: 'missing',
      problems: null,
      fallback: null,
      maintainedRepositories: [],
      editing: 'on',
    });
    expect(logs).toEqual([
      `No configuration file: using the defaults. Create ${path} to change them.`,
    ]);
  });

  it('falls back to the defaults when the first file is invalid', async () => {
    await save('[]');
    const file = new ConfigFile(path, { log });
    await file.load();
    expect(file.config).toBe(DEFAULT_CONFIG);
    expect(file.status).toEqual({
      state: 'invalid',
      problems: 'expected an object, got a list',
      fallback: 'defaults',
      maintainedRepositories: [],
      editing: 'blocked',
    });
  });

  it('reloads on change: invalid keeps the last valid configuration, fixed applies', async () => {
    await save({ pollIntervalSeconds: 30 });
    const changes: boolean[] = [];
    const { file, poll } = await watched(path, ({ configChanged }) => changes.push(configChanged));

    await save('{ "pollIntervalSeconds": 60, }');
    await poll();
    expect(file.status.state).toBe('invalid');
    expect(file.status.fallback).toBe('last_valid');
    expect(file.config.pollIntervalSeconds).toBe(30);

    await save({ pollIntervalSeconds: 60 });
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(60);
    expect(file.status).toMatchObject({ state: 'ok', problems: null, fallback: null });

    await rm(path);
    await poll();
    expect(file.status.state).toBe('missing');
    expect(file.config).toBe(DEFAULT_CONFIG);
    expect(changes).toEqual([false, true, true]);
    expect(logs.filter((line) => line.startsWith('Reloaded'))).toHaveLength(1);
    file.close();
  });

  it('ignores polls that find the same content, and a change seen only once', async () => {
    await save({ pollIntervalSeconds: 30 });
    let changes = 0;
    const { file, clock, poll } = await watched(path, () => (changes += 1));
    await poll();
    expect(changes).toBe(0);

    // A file caught half-written is not applied unless it is still the same on the next poll.
    await save('{ "pollIntervalSec');
    clock.fire();
    await file.settled();
    await save({ pollIntervalSeconds: 40 });
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(40);
    expect(changes).toBe(1);
    expect(logs.some((line) => line.startsWith('Invalid'))).toBe(false);
    file.close();
  });

  it('follows a symbolic link: target edited, target replaced, link retargeted', async () => {
    const dotfiles = join(dir, 'dotfiles');
    await mkdir(dotfiles);
    const target = join(dotfiles, 'viewer.json');
    await writeFile(target, JSON.stringify({ pollIntervalSeconds: 30 }));
    await symlink(target, path);
    const { file, poll } = await watched(path);
    expect(file.config.pollIntervalSeconds).toBe(30);

    await writeFile(target, JSON.stringify({ pollIntervalSeconds: 60 }));
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(60);

    await writeFile(join(dotfiles, 'viewer.json.new'), JSON.stringify({ pollIntervalSeconds: 90 }));
    await rename(join(dotfiles, 'viewer.json.new'), target);
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(90);

    const other = join(dotfiles, 'other.json');
    await writeFile(other, JSON.stringify({ pollIntervalSeconds: 120 }));
    await rm(path);
    await symlink(other, path);
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(120);
    file.close();
  });

  it('picks up a file whose directory is created after startup', async () => {
    const later = join(dir, 'later', 'config.json');
    const { file, poll } = await watched(later);
    expect(file.status.state).toBe('missing');

    await mkdir(join(dir, 'later'));
    await writeFile(later, JSON.stringify({ pollIntervalSeconds: 60 }));
    await poll();
    expect(file.config.pollIntervalSeconds).toBe(60);
    file.close();
  });

  it('stops polling on close', async () => {
    const { file, clock } = await watched(path);
    expect(clock.pending()).toBe(1);
    file.close();
    expect(clock.pending()).toBe(0);
    file.watch();
    file.close();
    expect(clock.pending()).toBe(0);
  });

  it('uses unreferenced timers by default, so polling never keeps the process alive', () => {
    const file = new ConfigFile(path, { log });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    file.watch();
    const handle = timeout.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    file.close();
    timeout.mockRestore();
  });
});

describe('ConfigFile.update', () => {
  const add =
    (name: string) =>
    (current: Config): Partial<Config> => ({
      maintainedRepositories: [...current.maintainedRepositories, name],
    });

  it('sets the keys of the edit, keeps the others as written, and applies the result at once', async () => {
    await save('{"port": 4700,\n  "maintainedRepositories": ["octo-org/widgets"]}');
    const changes: boolean[] = [];
    const { file, clock } = await watched(path, ({ configChanged }) => changes.push(configChanged));

    const update = await file.update(add('octo-org/gadgets'));

    expect(update).toMatchObject({
      kind: 'saved',
      config: { port: 4700, maintainedRepositories: ['octo-org/widgets', 'octo-org/gadgets'] },
    });
    // Defaults are not written for the keys the file leaves out.
    expect(await readFile(path, 'utf8')).toBe(
      '{\n  "port": 4700,\n  "maintainedRepositories": [\n    "octo-org/widgets",\n    "octo-org/gadgets"\n  ]\n}\n',
    );
    expect(file.config.maintainedRepositories).toEqual(['octo-org/widgets', 'octo-org/gadgets']);
    expect(file.status).toMatchObject({
      state: 'ok',
      maintainedRepositories: ['octo-org/widgets', 'octo-org/gadgets'],
    });
    expect(changes).toEqual([true]);
    expect(logs.at(-1)).toBe(`Saved the configuration to ${path}.`);

    // The watcher then finds what was written: nothing more to apply.
    clock.fire();
    await file.settled();
    clock.fire();
    await file.settled();
    expect(changes).toEqual([true]);
    expect(await readdir(dir)).toEqual(['config.json']);
    file.close();
  });

  it('creates the file, and its directory, when there is none', async () => {
    const nested = join(dir, 'not', 'yet', 'config.json');
    const file = new ConfigFile(nested, { log });
    await file.load();

    expect(await file.update(add('octo-org/widgets'))).toMatchObject({ kind: 'saved' });
    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({
      maintainedRepositories: ['octo-org/widgets'],
    });
    expect(file.status.state).toBe('ok');
  });

  it('edits the file as it is now, not the configuration in use', async () => {
    await save({ pollIntervalSeconds: 30 });
    const file = new ConfigFile(path, { log });
    await file.load();
    // Saved by hand a moment ago: not applied yet.
    await save({ pollIntervalSeconds: 60, excludedRepositories: ['octo-org/noisy'] });

    await file.update(add('octo-org/widgets'));

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      pollIntervalSeconds: 60,
      excludedRepositories: ['octo-org/noisy'],
      maintainedRepositories: ['octo-org/widgets'],
    });
    expect(file.config.pollIntervalSeconds).toBe(60);
  });

  it('leaves the file alone when the edit has nothing to change', async () => {
    await save('{ "port": 4700 }');
    const file = new ConfigFile(path, { log });
    await file.load();

    expect(await file.update(() => null)).toMatchObject({
      kind: 'unchanged',
      config: { port: 4700 },
    });
    expect(await readFile(path, 'utf8')).toBe('{ "port": 4700 }');
  });

  it('refuses to rewrite a file that has problems', async () => {
    await save('{ "port": "80" }');
    const file = new ConfigFile(path, { log });
    await file.load();
    expect(file.status.editing).toBe('blocked');

    expect(await file.update(add('octo-org/widgets'))).toEqual({
      kind: 'refused',
      reason: 'invalid',
      message:
        'The configuration file has problems; fix them first:\nport: expected an integer between 1 and 65535, got "80"',
    });
    expect(await readFile(path, 'utf8')).toBe('{ "port": "80" }');
  });

  it('refuses an edit that would make the file invalid', async () => {
    const file = new ConfigFile(path, { log });
    await file.load();

    expect(await file.update(() => ({ port: 0 }))).toMatchObject({
      kind: 'refused',
      reason: 'invalid',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('never writes in read-only mode', async () => {
    const file = new ConfigFile(path, { log, readOnly: true });
    await file.load();
    expect(file.status.editing).toBe('off');

    expect(await file.update(add('octo-org/widgets'))).toMatchObject({
      kind: 'refused',
      reason: 'read_only',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  // Root writes anywhere, whatever the permissions.
  it.skipIf(process.getuid?.() === 0)(
    'reports a file that cannot be written, without leaving a temporary file',
    async () => {
      const locked = join(dir, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'config.json'), '{}');
      await chmod(locked, 0o555);
      const file = new ConfigFile(join(locked, 'config.json'), { log });
      await file.load();

      try {
        expect(await file.update(add('octo-org/widgets'))).toEqual({
          kind: 'refused',
          reason: 'unwritable',
          message: 'The configuration file could not be written (EACCES).',
        });
        expect(await readdir(locked)).toEqual(['config.json']);
        expect(file.config.maintainedRepositories).toEqual([]);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it('writes through a symbolic link, keeping the link and the permissions of its target', async () => {
    const target = join(dir, 'dotfiles.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, path);
    const file = new ConfigFile(path, { log });
    await file.load();

    await file.update(add('octo-org/widgets'));

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      maintainedRepositories: ['octo-org/widgets'],
    });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('runs concurrent updates one after the other, losing none', async () => {
    const file = new ConfigFile(path, { log });
    await file.load();

    await Promise.all(['o/a', 'o/b', 'o/c'].map((name) => file.update(add(name))));

    expect(file.config.maintainedRepositories).toEqual(['o/a', 'o/b', 'o/c']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      maintainedRepositories: ['o/a', 'o/b', 'o/c'],
    });
  });
});

/** A clock whose timers only fire when the test says so. */
class ManualClock {
  #timers = new Map<number, () => void>();
  #next = 0;

  readonly clock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback) => {
      this.#next += 1;
      this.#timers.set(this.#next, callback);
      return this.#next;
    },
    clearTimeout: (handle) => {
      this.#timers.delete(handle as number);
    },
  };

  pending(): number {
    return this.#timers.size;
  }

  /** Fires the pending timers. */
  fire(): void {
    const callbacks = [...this.#timers.values()];
    this.#timers.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

/** A loaded and watched config file, with a function running polls until a change is applied. */
async function watched(
  filePath: string,
  onChange?: ConfigFileOptions['onChange'],
): Promise<{ file: ConfigFile; clock: ManualClock; poll: () => Promise<void> }> {
  const clock = new ManualClock();
  const file = new ConfigFile(filePath, { log, clock: clock.clock, ...(onChange && { onChange }) });
  await file.load();
  file.watch();
  return {
    file,
    clock,
    // A change is applied once two polls in a row see it.
    poll: async () => {
      for (let i = 0; i < 2; i += 1) {
        clock.fire();
        await file.settled();
      }
    },
  };
}
