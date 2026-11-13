import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, formatConfigIssues, parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('applies every default to an empty object', () => {
    expect(parseConfig({})).toEqual({ ok: true, config: DEFAULT_CONFIG });
    expect(DEFAULT_CONFIG).toEqual({
      maintainedRepositories: [],
      excludedRepositories: [],
      includeOwnRepositories: true,
      ownRepositoriesPushedWithinDays: 30,
      includeMyPullRequests: true,
      recentWindowHours: 24,
      pollIntervalSeconds: 15,
      port: 4680,
    });
  });

  it('reads every key', () => {
    const config = {
      maintainedRepositories: ['octo-org/widgets', 'octo-org/gadgets.js'],
      excludedRepositories: ['octocat/old_stuff'],
      includeOwnRepositories: false,
      ownRepositoriesPushedWithinDays: null,
      includeMyPullRequests: false,
      recentWindowHours: 0.5,
      pollIntervalSeconds: 60,
      port: 8080,
    };
    expect(parseConfig(config)).toEqual({ ok: true, config });
  });

  it('drops repositories listed twice, whatever their case', () => {
    const result = parseConfig({
      maintainedRepositories: ['Octo-Org/Widgets', 'octo-org/widgets'],
    });
    expect(result).toMatchObject({
      ok: true,
      config: { maintainedRepositories: ['Octo-Org/Widgets'] },
    });
  });

  it.each([
    [null, '', 'expected an object, got null'],
    [[], '', 'expected an object, got a list'],
    ['{}', '', 'expected an object, got "{}"'],
    [
      { maintainedRepositories: 'octo-org/widgets' },
      'maintainedRepositories',
      'expected a list of "owner/name" strings, got "octo-org/widgets"',
    ],
    [
      { excludedRepositories: [42] },
      'excludedRepositories[0]',
      'expected a repository as "owner/name", got 42',
    ],
    [
      { maintainedRepositories: ['widgets'] },
      'maintainedRepositories[0]',
      'expected a repository as "owner/name", got "widgets"',
    ],
    [
      { maintainedRepositories: ['https://github.com/octo-org/widgets'] },
      'maintainedRepositories[0]',
      'expected a repository as "owner/name", got "https://github.com/octo-org/widgets"',
    ],
    [
      { maintainedRepositories: ['octo-org/..'] },
      'maintainedRepositories[0]',
      'expected a repository as "owner/name", got "octo-org/.."',
    ],
    [
      { includeOwnRepositories: 'yes' },
      'includeOwnRepositories',
      'expected true or false, got "yes"',
    ],
    [{ includeMyPullRequests: null }, 'includeMyPullRequests', 'expected true or false, got null'],
    [
      { ownRepositoriesPushedWithinDays: 0 },
      'ownRepositoriesPushedWithinDays',
      'expected an integer >= 1 or null, got 0',
    ],
    [
      { ownRepositoriesPushedWithinDays: 1.5 },
      'ownRepositoriesPushedWithinDays',
      'expected an integer >= 1 or null, got 1.5',
    ],
    [{ recentWindowHours: -1 }, 'recentWindowHours', 'expected a number >= 0, got -1'],
    [{ recentWindowHours: '24' }, 'recentWindowHours', 'expected a number >= 0, got "24"'],
    [{ pollIntervalSeconds: 5 }, 'pollIntervalSeconds', 'expected an integer >= 10, got 5'],
    [{ port: 0 }, 'port', 'expected an integer between 1 and 65535, got 0'],
    [{ port: 70000 }, 'port', 'expected an integer between 1 and 65535, got 70000'],
    [{ port: { value: 1 } }, 'port', 'expected an integer between 1 and 65535, got an object'],
  ])('rejects %j at %j', (input, path, message) => {
    expect(parseConfig(input)).toEqual({ ok: false, issues: [{ path, message }] });
  });

  it('rejects unknown keys, naming the valid ones', () => {
    expect(parseConfig({ maintainedRepos: [] })).toEqual({
      ok: false,
      issues: [
        {
          path: 'maintainedRepos',
          message:
            'unknown key; expected one of maintainedRepositories, excludedRepositories, ' +
            'includeOwnRepositories, ownRepositoriesPushedWithinDays, includeMyPullRequests, ' +
            'recentWindowHours, pollIntervalSeconds, port',
        },
      ],
    });
  });

  it('reports every problem at once', () => {
    const result = parseConfig({
      maintainedRepositories: ['octo-org/widgets', 'nope', 'octo-org/gadgets', 3],
      port: '4680',
      pollIntervalSecs: 15,
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'maintainedRepositories[1]', message: expect.stringContaining('"nope"') as string },
        { path: 'maintainedRepositories[3]', message: expect.stringContaining('got 3') as string },
        { path: 'port', message: expect.stringContaining('"4680"') as string },
        { path: 'pollIntervalSecs', message: expect.stringContaining('unknown key') as string },
      ],
    });
  });
});

describe('formatConfigIssues', () => {
  it('prints one issue per line, prefixed by its path', () => {
    const text = formatConfigIssues([
      { path: '', message: 'expected an object, got null' },
      { path: 'port', message: 'expected an integer between 1 and 65535, got "4680"' },
    ]);
    expect(text).toBe(
      'expected an object, got null\nport: expected an integer between 1 and 65535, got "4680"',
    );
  });
});

describe('config.example.json', () => {
  it('is a valid configuration', () => {
    const text = readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8');
    expect(parseConfig(JSON.parse(text))).toMatchObject({ ok: true });
  });
});
