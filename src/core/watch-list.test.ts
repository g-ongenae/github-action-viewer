import { describe, expect, it } from 'vitest';

import { type Config, DEFAULT_CONFIG } from './config.ts';
import { resolveWatchList, type WatchListInput } from './watch-list.ts';

const NOW = new Date('2026-11-13T12:00:00Z');

const INPUT: WatchListInput = {
  ownRepositories: [
    { fullName: 'octocat/active', pushedAt: '2026-11-10T00:00:00Z' },
    { fullName: 'octocat/dormant', pushedAt: '2025-01-01T00:00:00Z' },
    { fullName: 'octocat/empty', pushedAt: null },
  ],
  pullRequestRepositories: ['octo-org/widgets', 'hubot/gizmo'],
};

function resolve(overrides: Partial<Config>, input: WatchListInput = INPUT) {
  return resolveWatchList({ ...DEFAULT_CONFIG, ...overrides }, input, NOW);
}

describe('resolveWatchList', () => {
  it('watches recently pushed own repositories, maintained ones and pull request ones', () => {
    expect(resolve({ maintainedRepositories: ['Octo-Org/Widgets', 'octo-org/gadgets'] })).toEqual([
      { fullName: 'hubot/gizmo', reasons: ['my_pull_request'] },
      { fullName: 'octo-org/gadgets', reasons: ['maintained'] },
      { fullName: 'Octo-Org/Widgets', reasons: ['maintained', 'my_pull_request'] },
      { fullName: 'octocat/active', reasons: ['own'] },
    ]);
  });

  it('watches every own repository when the push limit is off', () => {
    const names = resolve({ ownRepositoriesPushedWithinDays: null, includeMyPullRequests: false });
    expect(names.map((r) => r.fullName)).toEqual([
      'octocat/active',
      'octocat/dormant',
      'octocat/empty',
    ]);
  });

  it('honours the include switches', () => {
    expect(resolve({ includeOwnRepositories: false, includeMyPullRequests: false })).toEqual([]);
  });

  it('removes excluded repositories whatever the reason, ignoring case', () => {
    const names = resolve({
      maintainedRepositories: ['octo-org/widgets'],
      excludedRepositories: ['OCTO-ORG/widgets', 'octocat/Active'],
    });
    expect(names.map((r) => r.fullName)).toEqual(['hubot/gizmo']);
  });

  it('merges reasons of an own repository that is also maintained', () => {
    const names = resolve({
      maintainedRepositories: ['octocat/active'],
      includeMyPullRequests: false,
    });
    expect(names).toEqual([{ fullName: 'octocat/active', reasons: ['own', 'maintained'] }]);
  });
});
