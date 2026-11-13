import { describe, expect, it } from 'vitest';
import { carryOver, mergeWithPrevious, type Freshness, type Published } from './carry-over.ts';
import { collection, names, NOW, repo, snapshotOf } from './test-fixtures.ts';

const EARLIER = NOW - 60_000;
const EARLIER_ISO = new Date(EARLIER).toISOString();

function published(...repositories: Parameters<typeof snapshotOf>[0]): Published {
  return { snapshot: snapshotOf(repositories, EARLIER), staleRepositories: [] };
}

describe('carryOver', () => {
  it('publishes the first collection as is', () => {
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    expect(carryOver(null, collection(snapshot, { notRefreshed: ['octo-org/gadgets'] }))).toEqual({
      snapshot,
      staleRepositories: [],
    });
  });

  it('drops a repository that a complete collection no longer lists', () => {
    const previous = published(repo('octo-org/widgets'), repo('octo-org/gadgets'));
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    const result = carryOver(previous, collection(snapshot));
    expect(result).toEqual({ snapshot, staleRepositories: [] });
  });

  it('keeps the previous state of repositories that were not refreshed, in display order', () => {
    const previous = published(
      repo('octo-org/widgets'),
      repo('octo-org/gadgets', { active: true }),
      repo('octo-org/tools'),
    );
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    const result = carryOver(
      previous,
      collection(snapshot, { notRefreshed: ['Octo-Org/Gadgets', 'octo-org/tools'] }),
    );

    // The active repository comes first, as `buildSnapshot` orders them.
    expect(names(result.snapshot)).toEqual([
      'octo-org/gadgets',
      'octo-org/tools',
      'octo-org/widgets',
    ]);
    expect(result.snapshot.generatedAt).toBe(snapshot.generatedAt);
    expect(result.staleRepositories).toEqual([
      { fullName: 'octo-org/gadgets', lastRefreshedAt: EARLIER_ISO, lines: null },
      { fullName: 'octo-org/tools', lastRefreshedAt: EARLIER_ISO, lines: null },
    ]);
  });

  it('keeps the time of the last real refresh across several collections', () => {
    const first = carryOver(
      published(repo('octo-org/widgets'), repo('octo-org/gadgets')),
      collection(snapshotOf([repo('octo-org/widgets')]), { notRefreshed: ['octo-org/gadgets'] }),
    );
    const second = carryOver(
      first,
      collection(snapshotOf([repo('octo-org/widgets')], NOW + 15_000), {
        notRefreshed: ['octo-org/gadgets'],
      }),
    );
    expect(second.staleRepositories).toEqual([
      { fullName: 'octo-org/gadgets', lastRefreshedAt: EARLIER_ISO, lines: null },
    ]);

    const refreshed = carryOver(
      second,
      collection(snapshotOf([repo('octo-org/widgets'), repo('octo-org/gadgets')], NOW + 30_000)),
    );
    expect(refreshed.staleRepositories).toEqual([]);
  });

  it('does not invent a repository that was not shown before', () => {
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    const result = carryOver(
      published(repo('octo-org/widgets')),
      collection(snapshot, { notRefreshed: ['octo-org/gadgets'] }),
    );
    expect(result).toEqual({ snapshot, staleRepositories: [] });
  });

  it.each([
    [404, false],
    [403, false],
    [401, false],
    [502, true],
    [null, true],
  ])('after a failure with status %s, carries the repository over: %s', (httpStatus, kept) => {
    const snapshot = snapshotOf([], NOW, [
      { kind: 'repository', repository: 'octo-org/gadgets', httpStatus, message: 'failed' },
    ]);
    const result = carryOver(
      published(repo('octo-org/gadgets')),
      collection(snapshot, { notRefreshed: ['octo-org/gadgets'] }),
    );
    expect(names(result.snapshot)).toEqual(kept ? ['octo-org/gadgets'] : []);
    expect(result.snapshot.problems).toHaveLength(1);
  });
});

describe('mergeWithPrevious', () => {
  const complete: Freshness = {
    notRefreshed: new Set(),
    gone: new Set(),
    ownRepositoriesComplete: true,
    myPullRequestsComplete: true,
  };

  it('keeps own repositories while the list of own repositories is incomplete', () => {
    const previous = published(
      repo('octocat/widgets'),
      repo('octo-org/gadgets', { reasons: ['maintained'] }),
      repo('octo-org/tools', { reasons: ['my_pull_request'], pullRequests: [7] }),
    );
    const snapshot = snapshotOf([], NOW);

    const result = mergeWithPrevious(previous, snapshot, {
      ...complete,
      ownRepositoriesComplete: false,
    });
    // The maintained repository comes from the configuration, which is always complete.
    expect(names(result.snapshot)).toEqual(['octocat/widgets']);

    expect(names(mergeWithPrevious(previous, snapshot, complete).snapshot)).toEqual([]);
  });

  it('keeps repositories and pull request lines while the viewer’s pull requests are incomplete', () => {
    const previous = published(
      repo('octo-org/tools', { reasons: ['my_pull_request'], pullRequests: [7, 8] }),
      repo('octo-org/gizmos', { reasons: ['my_pull_request'], pullRequests: [3] }),
      // Lines of watched repositories come from their own pull request list.
      repo('octocat/widgets', { pullRequests: [5] }),
    );
    const snapshot = snapshotOf(
      [
        repo('octo-org/tools', { reasons: ['my_pull_request'], pullRequests: [8] }),
        repo('octocat/widgets'),
      ],
      NOW,
    );
    const incomplete = { ...complete, myPullRequestsComplete: false };

    const result = mergeWithPrevious(previous, snapshot, incomplete);
    expect(names(result.snapshot)).toEqual([
      'octo-org/gizmos',
      'octo-org/tools',
      'octocat/widgets',
    ]);
    const tools = result.snapshot.repositories.find((r) => r.fullName === 'octo-org/tools');
    expect(tools?.lines.map((line) => line.key)).toEqual(['pr:7', 'pr:8']);
    const widgets = result.snapshot.repositories.find((r) => r.fullName === 'octocat/widgets');
    expect(widgets?.lines.map((line) => line.key)).toEqual(['branch:main']);
    expect(result.staleRepositories).toEqual([
      { fullName: 'octo-org/gizmos', lastRefreshedAt: EARLIER_ISO, lines: null },
      { fullName: 'octo-org/tools', lastRefreshedAt: EARLIER_ISO, lines: ['pr:7'] },
    ]);

    const settled = mergeWithPrevious(previous, snapshot, complete);
    expect(settled).toEqual({ snapshot, staleRepositories: [] });
  });

  it('marks a repository active again when a kept line is active', () => {
    const previous = published(
      repo('octo-org/tools', { reasons: ['my_pull_request'], pullRequests: [7] }),
    );
    const activeLine = previous.snapshot.repositories[0]?.lines[0];
    if (activeLine === undefined) {
      throw new Error('fixture');
    }
    const withActive: Published = {
      ...previous,
      snapshot: {
        ...previous.snapshot,
        repositories: previous.snapshot.repositories.map((r) => ({
          ...r,
          active: true,
          lines: [{ ...activeLine, active: true }],
        })),
      },
    };
    const snapshot = snapshotOf(
      [repo('octo-org/tools', { reasons: ['my_pull_request'], pullRequests: [8] })],
      NOW,
    );
    const result = mergeWithPrevious(withActive, snapshot, {
      ...complete,
      myPullRequestsComplete: false,
    });
    expect(result.snapshot.repositories[0]?.active).toBe(true);
  });

  it('drops a repository that failed for good even when its source is incomplete', () => {
    const previous = published(repo('octocat/widgets'));
    const result = mergeWithPrevious(previous, snapshotOf([], NOW), {
      ...complete,
      gone: new Set(['octocat/widgets']),
      notRefreshed: new Set(['octocat/widgets']),
      ownRepositoriesComplete: false,
    });
    expect(names(result.snapshot)).toEqual([]);
  });
});
