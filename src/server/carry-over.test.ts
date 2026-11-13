import { describe, expect, it } from 'vitest';
import type { RepositoryInput } from '../core/inputs.ts';
import { carryOver, type Published } from './carry-over.ts';
import { collection, names, NOW, repo, snapshotOf } from './test-fixtures.ts';

const EARLIER = NOW - 60_000;
const EARLIER_ISO = new Date(EARLIER).toISOString();

function published(...repositories: RepositoryInput[]): Published {
  return { snapshot: snapshotOf(repositories, EARLIER), staleRepositories: [] };
}

/** Pull request lines of a repository of the snapshot. */
function lineKeys(result: Published, fullName: string): string[] | undefined {
  return result.snapshot.repositories
    .find((repository) => repository.fullName === fullName)
    ?.lines.map((line) => line.key);
}

describe('carryOver', () => {
  it('publishes the first collection as is', () => {
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    expect(carryOver(null, collection(snapshot, { notRefreshed: ['octo-org/gadgets'] }))).toEqual({
      snapshot,
      staleRepositories: [],
    });
  });

  // The previous page shows `octo-org/widgets` with pull requests #7 and #8.
  const previous = published(repo('octo-org/widgets', { pullRequests: [7, 8] }));
  const newer = repo('octo-org/widgets', { pullRequests: [8] });

  it.each<{
    name: string;
    shown: RepositoryInput[];
    refreshed: string[];
    notRefreshed: string[];
    watchListComplete: boolean;
    lines: string[] | undefined;
    stale: boolean;
  }>([
    {
      name: 'refreshed: the new view',
      shown: [newer],
      refreshed: ['octo-org/widgets'],
      notRefreshed: [],
      watchListComplete: true,
      lines: ['branch:main', 'pr:8'],
      stale: false,
    },
    {
      name: 'refreshed and absent: no line left',
      shown: [],
      refreshed: ['octo-org/widgets'],
      notRefreshed: [],
      watchListComplete: false,
      lines: undefined,
      stale: false,
    },
    {
      name: 'not refreshed and absent: the previous view',
      shown: [],
      refreshed: [],
      notRefreshed: ['octo-org/widgets'],
      watchListComplete: true,
      lines: ['branch:main', 'pr:7', 'pr:8'],
      stale: true,
    },
    {
      name: 'not refreshed but present (possibly incomplete): the previous view',
      shown: [newer],
      refreshed: [],
      notRefreshed: ['Octo-Org/Widgets'],
      watchListComplete: true,
      lines: ['branch:main', 'pr:7', 'pr:8'],
      stale: true,
    },
    {
      name: 'in neither, watch list complete: dropped',
      shown: [],
      refreshed: [],
      notRefreshed: [],
      watchListComplete: true,
      lines: undefined,
      stale: false,
    },
    {
      name: 'in neither, watch list incomplete: the previous view',
      shown: [],
      refreshed: [],
      notRefreshed: [],
      watchListComplete: false,
      lines: ['branch:main', 'pr:7', 'pr:8'],
      stale: true,
    },
  ])('$name', ({ shown, refreshed, notRefreshed, watchListComplete, lines, stale }) => {
    const result = carryOver(
      previous,
      collection(snapshotOf(shown), { refreshed, notRefreshed, watchListComplete }),
    );
    expect(lineKeys(result, 'octo-org/widgets')).toEqual(lines);
    expect(result.staleRepositories).toEqual(
      stale ? [{ fullName: 'octo-org/widgets', lastRefreshedAt: EARLIER_ISO }] : [],
    );
  });

  it('uses the new view of a repository not refreshed but never shown before', () => {
    const snapshot = snapshotOf([repo('octo-org/gadgets', { pullRequests: [3] })]);
    const result = carryOver(
      published(),
      collection(snapshot, { refreshed: [], notRefreshed: ['octo-org/gadgets'] }),
    );
    expect(result).toEqual({ snapshot, staleRepositories: [] });
  });

  it('shows only the problem of a repository that never had a view (a typo in the config)', () => {
    const snapshot = snapshotOf([repo('octo-org/widgets')], NOW, [
      { kind: 'repository', repository: 'octo-org/widgest', httpStatus: 404, message: 'Not Found' },
    ]);
    const result = carryOver(
      published(repo('octo-org/widgets')),
      collection(snapshot, { notRefreshed: ['octo-org/widgest'] }),
    );
    expect(result).toEqual({ snapshot, staleRepositories: [] });
    expect(result.snapshot.problems).toHaveLength(1);
  });

  it('keys previous views by the snapshot’s name, whatever the case', () => {
    // A repository renamed on GitHub is reported under its current name everywhere.
    const result = carryOver(
      published(repo('octo-org/Widgets')),
      collection(snapshotOf([]), { notRefreshed: ['OCTO-ORG/widgets'] }),
    );
    expect(names(result.snapshot)).toEqual(['octo-org/Widgets']);
  });

  it('merges kept and new repositories in display order', () => {
    const before = published(
      repo('octo-org/widgets'),
      repo('octo-org/gadgets', { active: true }),
      repo('octo-org/tools'),
    );
    const snapshot = snapshotOf([repo('octo-org/widgets')]);
    const result = carryOver(
      before,
      collection(snapshot, { notRefreshed: ['octo-org/gadgets', 'octo-org/tools'] }),
    );
    // The active repository comes first, as `buildSnapshot` orders them.
    expect(names(result.snapshot)).toEqual([
      'octo-org/gadgets',
      'octo-org/tools',
      'octo-org/widgets',
    ]);
    expect(result.snapshot.generatedAt).toBe(snapshot.generatedAt);
    expect(result.staleRepositories.map((stale) => stale.fullName)).toEqual([
      'octo-org/gadgets',
      'octo-org/tools',
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
      { fullName: 'octo-org/gadgets', lastRefreshedAt: EARLIER_ISO },
    ]);

    const refreshed = carryOver(
      second,
      collection(snapshotOf([repo('octo-org/widgets'), repo('octo-org/gadgets')], NOW + 30_000)),
    );
    expect(refreshed.staleRepositories).toEqual([]);
  });
});
