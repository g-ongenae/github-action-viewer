import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { ConfigFile, configPath, readConfigFile } from './config-file.ts';

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
        'pollIntervalSeconds: expected an integer >= 10, got 1\nport: expected an integer between 1 and 65535, got "80"',
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
    const file = new ConfigFile(path, {
      log,
      debounceMs: 20,
      onChange: ({ configChanged }) => changes.push(configChanged),
    });
    await file.load();
    file.watch();
    try {
      await save('{ "pollIntervalSeconds": 60, }');
      await vi.waitFor(
        () => {
          expect(file.status.state).toBe('invalid');
        },
        {
          timeout: 10_000,
          interval: 50,
        },
      );
      expect(file.status.fallback).toBe('last_valid');
      expect(file.config.pollIntervalSeconds).toBe(30);

      await save({ pollIntervalSeconds: 60 });
      await vi.waitFor(
        () => {
          expect(file.config.pollIntervalSeconds).toBe(60);
        },
        {
          timeout: 10_000,
          interval: 50,
        },
      );
      expect(file.status).toEqual({ state: 'ok', problems: null, fallback: null });

      await rm(path);
      await vi.waitFor(
        () => {
          expect(file.status.state).toBe('missing');
        },
        {
          timeout: 10_000,
          interval: 50,
        },
      );
      expect(file.config).toBe(DEFAULT_CONFIG);
      await file.settled();
      expect(changes).toEqual([false, true, true]);
      expect(logs.filter((line) => line.startsWith('Reloaded'))).toHaveLength(1);
    } finally {
      file.close();
    }
  });

  it('ignores events that do not change the content', async () => {
    await save({ pollIntervalSeconds: 30 });
    let changes = 0;
    const file = new ConfigFile(path, { log, debounceMs: 20, onChange: () => (changes += 1) });
    await file.load();
    file.watch();
    try {
      await save({ pollIntervalSeconds: 30 });
      await save({ pollIntervalSeconds: 40 });
      await vi.waitFor(
        () => {
          expect(file.config.pollIntervalSeconds).toBe(40);
        },
        {
          timeout: 10_000,
          interval: 50,
        },
      );
      await save({ pollIntervalSeconds: 40 });
      await new Promise((done) => setTimeout(done, 200));
      await file.settled();
      expect(changes).toBe(1);
    } finally {
      file.close();
    }
  });

  it('logs when the directory cannot be watched', () => {
    const file = new ConfigFile(join(dir, 'missing', 'config.json'), { log });
    file.watch();
    file.close();
    expect(logs.at(-1)).toMatch(/^Cannot watch .*restart to apply changes\.$/);
  });
});
