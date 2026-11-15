import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, type Config } from '../core/config.ts';
import { GitHubClient } from '../github/client.ts';
import { FakeGitHub, rawRepository, TOKEN } from '../github/test-fixtures.ts';
import type { ConfigEdit, ConfigUpdate } from './config-file.ts';
import { CATALOGUE_TTL_MS, ConfigWatchListEditor, WatchListError } from './watch-list-editor.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');

/** A configuration "file" kept in memory, applying edits the way `ConfigFile.update` does. */
class FakeConfigFile {
  config: Config;
  refusal: Extract<ConfigUpdate, { kind: 'refused' }> | null = null;
  updates = 0;

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  update(edit: ConfigEdit): Promise<ConfigUpdate> {
    this.updates += 1;
    if (this.refusal !== null) {
      return Promise.resolve(this.refusal);
    }
    const changes = edit(this.config);
    if (changes === null) {
      return Promise.resolve({ kind: 'unchanged', config: this.config });
    }
    const parsed = parseConfig({ ...this.config, ...changes });
    if (!parsed.ok) {
      throw new Error('The edit made the configuration invalid.');
    }
    this.config = parsed.config;
    return Promise.resolve({ kind: 'saved', config: this.config });
  }
}

function setup(config: Partial<Config> = {}): {
  github: FakeGitHub;
  file: FakeConfigFile;
  editor: ConfigWatchListEditor;
  clock: { now: number; rateLimitedUntil: number | null };
} {
  const github = new FakeGitHub();
  const file = new FakeConfigFile(config);
  const clock: { now: number; rateLimitedUntil: number | null } = {
    now: NOW,
    rateLimitedUntil: null,
  };
  const editor = new ConfigWatchListEditor({
    client: new GitHubClient({ token: TOKEN, fetch: github.fetch, now: () => new Date(clock.now) }),
    configFile: file,
    rateLimitedUntil: () => clock.rateLimitedUntil,
    now: () => clock.now,
  });
  return { github, file, editor, clock };
}

/** The refusal `promise` rejects with: its status and its message. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof WatchListError)) {
    throw new Error(`Expected a WatchListError, got ${String(error)}`);
  }
  return { status: error.status, message: error.message };
}

describe('ConfigWatchListEditor.add', () => {
  it('checks the repository with GitHub and adds it under its current name', async () => {
    const { github, file, editor } = setup({ maintainedRepositories: ['o/first'] });
    github.on('/repos/octo-org/widgets', { body: rawRepository('Octo-Org/Widgets') });

    expect(await editor.add('octo-org/widgets')).toEqual({
      repository: 'Octo-Org/Widgets',
      changed: true,
      maintainedRepositories: ['o/first', 'Octo-Org/Widgets'],
    });
    expect(file.config.maintainedRepositories).toEqual(['o/first', 'Octo-Org/Widgets']);
    expect(github.paths).toEqual(['/repos/octo-org/widgets']);
  });

  it('adds a private repository of another organisation like any other', async () => {
    const { github, editor } = setup();
    github.on('/repos/other-org/secret', {
      body: rawRepository('other-org/secret', { private: true }),
    });

    expect((await editor.add('other-org/secret')).maintainedRepositories).toEqual([
      'other-org/secret',
    ]);
  });

  it('has nothing to do for a repository already added, whatever the casing', async () => {
    const { github, file, editor } = setup({ maintainedRepositories: ['octo-org/widgets'] });
    github.on('/repos/OCTO-ORG/WIDGETS', { body: rawRepository('octo-org/widgets') });

    expect(await editor.add('OCTO-ORG/WIDGETS')).toEqual({
      repository: 'octo-org/widgets',
      changed: false,
      maintainedRepositories: ['octo-org/widgets'],
    });
    expect(file.config.maintainedRepositories).toEqual(['octo-org/widgets']);
  });

  it('counts an old name still in the file as the same repository', async () => {
    const { github, editor } = setup({ maintainedRepositories: ['octo-org/old-name'] });
    github.on('/repos/octo-org/old-name', { body: rawRepository('octo-org/new-name') });

    expect(await editor.add('octo-org/old-name')).toMatchObject({
      repository: 'octo-org/new-name',
      changed: false,
    });
  });

  it('stops excluding a repository that is added', async () => {
    const { github, file, editor } = setup({
      excludedRepositories: ['Octo-Org/Widgets', 'o/noisy'],
    });
    github.on('/repos/octo-org/widgets', { body: rawRepository('octo-org/widgets') });

    expect((await editor.add('octo-org/widgets')).changed).toBe(true);
    expect(file.config).toMatchObject({
      maintainedRepositories: ['octo-org/widgets'],
      excludedRepositories: ['o/noisy'],
    });
  });

  it('refuses what is not a repository name, without asking GitHub', async () => {
    const { github, file, editor } = setup();

    for (const name of ['', 'widgets', 'octo-org/', 'o/r/extra', 'o/..', 'o/r?x=1', '../o/r']) {
      expect(await refusal(editor.add(name))).toEqual({
        status: 400,
        message: 'Expected a repository as owner/name.',
      });
    }
    expect(github.requests).toHaveLength(0);
    expect(file.updates).toBe(0);
  });

  it('says so when GitHub does not find the repository, and adds nothing', async () => {
    const { file, editor } = setup();

    expect(await refusal(editor.add('octo-org/secret'))).toEqual({
      status: 404,
      message: 'octo-org/secret was not found on GitHub, or the token cannot read it.',
    });
    expect(file.updates).toBe(0);
  });

  it('passes on why GitHub denies access', async () => {
    const { github, editor } = setup();
    github.on('/repos/sso-org/app', {
      status: 403,
      body: { message: 'Resource protected by organization SAML enforcement.' },
    });

    expect(await refusal(editor.add('sso-org/app'))).toEqual({
      status: 403,
      message:
        'sso-org/app could not be checked: GET /repos/sso-org/app: 403 Resource protected by organization SAML enforcement.',
    });
  });

  it('reports a rate limit hit by the check, with when to try again', async () => {
    const { github, editor } = setup();
    github.on('/repos/o/r', {
      status: 429,
      body: { message: 'Too many requests' },
      headers: { 'retry-after': '170' },
    });

    expect(await refusal(editor.add('o/r'))).toEqual({
      status: 429,
      message: 'GitHub’s rate limit was reached: try again in 3 minutes.',
    });
  });

  it('sends nothing to GitHub while a rate limit is in effect', async () => {
    const { github, editor, clock } = setup();
    clock.rateLimitedUntil = NOW + 30_000;

    expect(await refusal(editor.add('o/r'))).toEqual({
      status: 429,
      message: 'GitHub’s rate limit was reached: try again in a minute.',
    });
    expect(await refusal(editor.catalogue())).toMatchObject({ status: 429 });
    expect(github.requests).toHaveLength(0);

    clock.now = NOW + 30_000;
    github.on('/repos/o/r', { body: rawRepository('o/r') });
    expect((await editor.add('o/r')).changed).toBe(true);
  });

  it('passes on the refusal of the configuration file', async () => {
    const { github, file, editor } = setup();
    github.on('/repos/o/r', { body: rawRepository('o/r') });

    file.refusal = { kind: 'refused', reason: 'invalid', message: 'Fix the file first.' };
    expect(await refusal(editor.add('o/r'))).toEqual({
      status: 409,
      message: 'Fix the file first.',
    });
    file.refusal = { kind: 'refused', reason: 'unwritable', message: 'Cannot write (EACCES).' };
    expect(await refusal(editor.add('o/r'))).toMatchObject({ status: 500 });
  });
});

describe('ConfigWatchListEditor.remove', () => {
  it('removes the repository, whatever the casing, without asking GitHub', async () => {
    const { github, file, editor } = setup({ maintainedRepositories: ['o/a', 'Octo-Org/Gone'] });

    expect(await editor.remove('octo-org/gone')).toEqual({
      repository: 'octo-org/gone',
      changed: true,
      maintainedRepositories: ['o/a'],
    });
    expect(file.config.maintainedRepositories).toEqual(['o/a']);
    expect(github.requests).toHaveLength(0);
  });

  it('has nothing to do for a repository that is not in the list', async () => {
    const { editor } = setup({ maintainedRepositories: ['o/a'] });

    expect(await editor.remove('o/b')).toEqual({
      repository: 'o/b',
      changed: false,
      maintainedRepositories: ['o/a'],
    });
  });

  it('refuses what is not a repository name', async () => {
    const { editor } = setup();

    expect(await refusal(editor.remove('not a name'))).toMatchObject({ status: 400 });
  });
});

describe('ConfigWatchListEditor.catalogue', () => {
  const LIST = '/user/repos';

  it('lists the repositories GitHub knows for the user, and keeps the list for a while', async () => {
    const { github, editor, clock } = setup();
    github.on(LIST, {
      body: [rawRepository('o/private', { private: true }), rawRepository('o/public')],
      etag: '"v1"',
    });

    const catalogue = await editor.catalogue();
    expect(catalogue).toEqual({
      repositories: [
        { fullName: 'o/private', private: true },
        { fullName: 'o/public', private: false },
      ],
      complete: true,
    });

    clock.now += CATALOGUE_TTL_MS - 1;
    expect(await editor.catalogue()).toBe(catalogue);
    expect(github.requests).toHaveLength(1);

    // Then asked again, for free while nothing changed.
    clock.now += 1;
    expect(await editor.catalogue()).toEqual(catalogue);
    expect(github.requests).toHaveLength(2);
    expect(github.requests[1]?.headers.get('if-none-match')).toBe('"v1"');
  });

  it('asks GitHub once for callers arriving at the same time', async () => {
    const { github, editor } = setup();
    github.on(LIST, { body: [rawRepository('o/r')] });

    const [first, second] = await Promise.all([editor.catalogue(), editor.catalogue()]);

    expect(first).toBe(second);
    expect(github.requests).toHaveLength(1);
  });

  it('explains a failure and tries again the next time', async () => {
    const { github, editor } = setup();
    github.on(LIST, { status: 500, body: { message: 'Server Error' } });

    expect(await refusal(editor.catalogue())).toMatchObject({
      status: 502,
      message: expect.stringMatching(
        /^Your repositories could not be listed: GET \/user\/repos/,
      ) as string,
    });

    github.on(LIST, { body: [rawRepository('o/r')] });
    expect((await editor.catalogue()).repositories).toHaveLength(1);
  });
});
