import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config.ts';
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
    expect(file.status).toEqual({ state: 'missing', problems: null, fallback: null });
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
    expect(file.status).toEqual({ state: 'ok', problems: null, fallback: null });

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
