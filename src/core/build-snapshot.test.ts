import { describe, expect, it } from 'vitest';

import { buildSnapshot, type SnapshotInput } from './build-snapshot.ts';
import type { RepositoryInput } from './inputs.ts';
import type { LineView, RepositoryView } from './snapshot.ts';
import { FORK, pullRequest, REPO, repository, run, VIEWER } from './test-fixtures.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const OPTIONS = { now: NOW, recentWindowHours: 24 };

function snapshotOf(...repositories: RepositoryInput[]) {
  return buildSnapshot({ viewer: VIEWER, repositories, problems: [], rateLimit: null }, OPTIONS);
}

/** The single repository of the snapshot (fails if there is not exactly one). */
function only(...repositories: RepositoryInput[]): RepositoryView {
  const [view, ...others] = snapshotOf(...repositories).repositories;
  if (!view || others.length > 0) {
    throw new Error('expected exactly one repository in the snapshot');
  }
  return view;
}

function line(view: RepositoryView, key: string): LineView {
  const found = view.lines.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no line ${key} in ${keys(view).join(', ')}`);
  }
  return found;
}

const keys = (view: RepositoryView) => view.lines.map((candidate) => candidate.key);

describe('buildSnapshot', () => {
  it('passes through the viewer, problems and rate limit, and stamps the time', () => {
    const input: SnapshotInput = {
      viewer: VIEWER,
      repositories: [],
      problems: [{ kind: 'repository', repository: REPO, httpStatus: 404, message: 'Not found' }],
      rateLimit: { limit: 5000, remaining: 4990, resetAt: '2026-11-13T13:00:00Z' },
    };
    const snapshot = buildSnapshot(input, OPTIONS);
    expect(snapshot).toEqual({ ...input, generatedAt: '2026-11-13T12:00:00.000Z' });
  });

  it('builds a default-branch line from the head commit and its runs', () => {
    const view = only(repository({ runs: [run({ id: 1 })] }));
    expect(view).toMatchObject({
      fullName: REPO,
      url: `https://github.com/${REPO}`,
      reasons: ['own'],
      active: false,
    });
    expect(view.lines).toEqual([
      expect.objectContaining({
        key: 'branch:main',
        kind: 'default_branch',
        label: 'main',
        pullRequest: null,
        state: 'success',
        failed: 0,
        active: false,
        date: '2026-11-13T10:00:00Z',
        updatedAt: '2026-11-13T10:05:00Z',
        commit: { sha: 'sha-main', title: 'Commit title', authorName: 'Mona Lisa' },
      }),
    ]);
    expect(view.lines[0]?.runs).toEqual([
      {
        id: 1,
        workflowName: 'CI',
        state: 'success',
        url: `https://github.com/${REPO}/actions/runs/1`,
        event: 'push',
        runNumber: 1,
        runAttempt: 1,
        headSha: 'sha-main',
        superseded: false,
        createdAt: '2026-11-13T10:00:00Z',
        startedAt: '2026-11-13T10:00:05Z',
        updatedAt: '2026-11-13T10:05:00Z',
      },
    ]);
  });

  it('produces plain JSON', () => {
    const snapshot = snapshotOf(
      repository({
        runs: [run({ id: 1 }), run({ id: 2, headBranch: 'feature', pullRequestNumbers: [7] })],
        pullRequests: [pullRequest()],
      }),
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('falls back to the display title when GitHub sends no head commit', () => {
    const view = only(repository({ runs: [run({ headCommit: null, displayTitle: 'Release' })] }));
    expect(view.lines[0]?.commit).toEqual({ sha: 'sha-main', title: 'Release', authorName: null });
  });

  it('keeps only the first line of the commit message', () => {
    const headCommit = { message: '  Fix the thing\r\n\r\nDetails', authorName: 'Mona Lisa' };
    const view = only(repository({ runs: [run({ headCommit })] }));
    expect(view.lines[0]?.commit.title).toBe('Fix the thing');
  });
});

describe('newest commit of a line', () => {
  it('shows only the runs of the newest commit and drops finished runs of older ones', () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, headSha: 'old', conclusion: 'failure', createdAt: '2026-11-13T09:00:00Z' }),
          run({ id: 2, headSha: 'new', createdAt: '2026-11-13T10:00:00Z' }),
        ],
      }),
    );
    const main = line(view, 'branch:main');
    expect(main.commit.sha).toBe('new');
    expect(main.state).toBe('success');
    expect(main.runs.map((r) => r.id)).toEqual([2]);
  });

  it('keeps runs still active on an older commit, marked as superseded', () => {
    const view = only(
      repository({
        runs: [
          run({
            id: 1,
            headSha: 'old',
            status: 'in_progress',
            conclusion: null,
            createdAt: '2026-11-13T09:00:00Z',
          }),
          run({ id: 2, headSha: 'new', createdAt: '2026-11-13T10:00:00Z' }),
        ],
      }),
    );
    const main = line(view, 'branch:main');
    // `state` reads active because something on the ref still runs; `commitState`, `counts` and
    // `failed` keep the verdict on the newest commit.
    expect(main).toMatchObject({ state: 'in_progress', commitState: 'success', failed: 0 });
    expect(main.counts).toMatchObject({ success: 1, in_progress: 0 });
    expect(main.active).toBe(true);
    expect(view.active).toBe(true);
    expect(main.runs.map((r) => [r.id, r.superseded, r.headSha])).toEqual([
      [2, false, 'new'],
      [1, true, 'old'],
    ]);
  });

  it('shows "running, latest commit failed" when the newest commit failed under an older run', () => {
    const view = only(
      repository({
        runs: [
          run({
            id: 1,
            headSha: 'old',
            status: 'queued',
            conclusion: null,
            createdAt: '2026-11-13T09:00:00Z',
          }),
          run({ id: 2, headSha: 'new', conclusion: 'failure', createdAt: '2026-11-13T10:00:00Z' }),
        ],
      }),
    );
    expect(line(view, 'branch:main')).toMatchObject({
      state: 'queued',
      commitState: 'failure',
      failed: 1,
      active: true,
    });
  });

  it('keeps the latest run per workflow and event: highest run number, then attempt', () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, runNumber: 1, conclusion: 'failure' }),
          run({ id: 2, runNumber: 2, runAttempt: 1, conclusion: 'failure' }),
          run({ id: 3, runNumber: 2, runAttempt: 2, conclusion: 'success' }),
          run({ id: 4, workflowId: 200, workflowName: 'Lint', runNumber: 1 }),
          run({
            id: 5,
            event: 'workflow_dispatch',
            runNumber: 3,
            status: 'queued',
            conclusion: null,
          }),
        ],
      }),
    );
    const main = line(view, 'branch:main');
    expect(main.runs.map((r) => [r.workflowName, r.event, r.id])).toEqual([
      ['CI', 'push', 3],
      ['CI', 'workflow_dispatch', 5],
      ['Lint', 'push', 4],
    ]);
    expect(main.state).toBe('queued');
    expect(main.counts).toMatchObject({ success: 2, queued: 1, failure: 0 });
  });

  it('shows "running, 1 failed" when a run failed while another is running', () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, conclusion: 'failure' }),
          run({ id: 2, workflowId: 200, status: 'in_progress', conclusion: null }),
        ],
      }),
    );
    expect(line(view, 'branch:main')).toMatchObject({ state: 'in_progress', failed: 1 });
  });

  it('ignores a duplicated run, keeping its most recent copy', () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, status: 'in_progress', conclusion: null }),
          run({ id: 1, updatedAt: '2026-11-13T10:09:00Z' }),
        ],
      }),
    );
    expect(line(view, 'branch:main').runs).toEqual([
      expect.objectContaining({ id: 1, state: 'success' }),
    ]);
  });

  it("follows the pull request's head commit when it has runs, even if older runs are newer", () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, headBranch: 'feature', headSha: 'sha-feature', pullRequestNumbers: [7] }),
          // A later-created run for a commit the pull request no longer points at (force-push).
          run({
            id: 2,
            headBranch: 'feature',
            headSha: 'dropped',
            pullRequestNumbers: [7],
            createdAt: '2026-11-13T11:00:00Z',
          }),
        ],
        pullRequests: [pullRequest()],
      }),
    );
    expect(line(view, 'pr:7').commit.sha).toBe('sha-feature');
  });
});

describe('mapping runs to pull requests', () => {
  it("puts every run of a pull request's branch on its line, pushes included", () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, headBranch: 'feature', headSha: 'sha-feature', pullRequestNumbers: [7] }),
          run({
            id: 2,
            event: 'pull_request',
            headBranch: 'feature',
            headSha: 'sha-feature',
            pullRequestNumbers: [7],
          }),
        ],
        pullRequests: [pullRequest({ draft: true })],
      }),
    );
    expect(keys(view)).toEqual(['pr:7']);
    expect(line(view, 'pr:7')).toMatchObject({
      kind: 'pull_request',
      label: '#7',
      pullRequest: {
        number: 7,
        title: 'Add a feature',
        author: VIEWER,
        url: `https://github.com/${REPO}/pull/7`,
        draft: true,
      },
    });
    // Same workflow: ordered by event, `pull_request` before `push`.
    expect(line(view, 'pr:7').runs.map((r) => [r.id, r.event])).toEqual([
      [2, 'pull_request'],
      [1, 'push'],
    ]);
  });

  it('matches a fork pull request by head commit when GitHub gives no association', () => {
    const view = only(
      repository({
        runs: [
          run({ event: 'pull_request', headBranch: 'patch', headSha: 'f1', headRepository: FORK }),
        ],
        pullRequests: [pullRequest({ headBranch: 'patch', headSha: 'f1', headRepository: FORK })],
      }),
    );
    expect(keys(view)).toEqual(['pr:7']);
  });

  it('matches older runs of a fork pull request by head branch and repository', () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1, headBranch: 'patch', headSha: 'f2', headRepository: FORK }),
          run({
            id: 2,
            headBranch: 'patch',
            headSha: 'f1',
            headRepository: FORK,
            status: 'in_progress',
            conclusion: null,
            createdAt: '2026-11-13T09:00:00Z',
          }),
        ],
        pullRequests: [pullRequest({ headBranch: 'patch', headSha: 'f2', headRepository: FORK })],
      }),
    );
    expect(line(view, 'pr:7').runs.map((r) => [r.id, r.superseded])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("does not fold a fork's main into the default-branch line", () => {
    const view = only(
      repository({
        runs: [
          run({ id: 1 }),
          run({ id: 2, event: 'pull_request', headSha: 'f1', headRepository: FORK.toUpperCase() }),
        ],
        pullRequests: [pullRequest({ headBranch: 'main', headSha: 'f1', headRepository: FORK })],
      }),
    );
    expect(keys(view)).toEqual(['branch:main', 'pr:7']);
    expect(line(view, 'branch:main').runs.map((r) => r.id)).toEqual([1]);
    expect(line(view, 'pr:7').runs.map((r) => r.id)).toEqual([2]);
  });

  it('shows both lines for a pull request whose head is the default branch', () => {
    const view = only(
      repository({
        runs: [run({ pullRequestNumbers: [7] })],
        pullRequests: [pullRequest({ headBranch: 'main', headSha: 'sha-main' })],
      }),
    );
    expect(keys(view)).toEqual(['branch:main', 'pr:7']);
    expect(line(view, 'pr:7').runs.map((r) => r.id)).toEqual([1]);
  });

  it('does not attach default-branch runs to a fork pull request on the same commit', () => {
    const view = only(
      repository({
        runs: [run()],
        pullRequests: [
          pullRequest({ headBranch: 'main', headSha: 'sha-main', headRepository: FORK }),
        ],
      }),
    );
    expect(keys(view)).toEqual(['branch:main']);
  });

  it('matches a pull request from a deleted fork by head commit', () => {
    const view = only(
      repository({
        runs: [run({ headBranch: 'patch', headSha: 'f1', headRepository: null })],
        pullRequests: [pullRequest({ headBranch: 'patch', headSha: 'f1', headRepository: null })],
      }),
    );
    expect(keys(view)).toEqual(['pr:7']);
  });

  it('puts an associated run without a head branch on its pull request line', () => {
    const view = only(
      repository({
        runs: [run({ headBranch: null, headSha: 'sha-feature', pullRequestNumbers: [7] })],
        pullRequests: [pullRequest()],
      }),
    );
    expect(keys(view)).toEqual(['pr:7']);
  });

  it('lists a run once when it matches a pull request both by association and by head', () => {
    const view = only(
      repository({
        runs: [run({ headBranch: 'feature', headSha: 'sha-feature', pullRequestNumbers: [7] })],
        pullRequests: [pullRequest()],
      }),
    );
    expect(line(view, 'pr:7').runs.map((r) => r.id)).toEqual([1]);
  });

  it('compares the head repository case-insensitively', () => {
    const view = only(repository({ runs: [run({ headRepository: REPO.toUpperCase() })] }));
    expect(keys(view)).toEqual(['branch:main']);
  });

  it('drops runs of a fork that match no open pull request', () => {
    const view = only(
      repository({
        runs: [run({ id: 1 }), run({ id: 2, headBranch: 'patch', headRepository: FORK })],
      }),
    );
    expect(keys(view)).toEqual(['branch:main']);
  });

  it('shows a run of a closed pull request on its branch line', () => {
    const view = only(
      repository({ runs: [run({ headBranch: 'feature', pullRequestNumbers: [3] })] }),
    );
    expect(keys(view)).toEqual(['branch:feature']);
    expect(line(view, 'branch:feature').kind).toBe('branch');
  });

  it('puts a run on every open pull request GitHub associates it with', () => {
    const view = only(
      repository({
        runs: [run({ headBranch: 'feature', headSha: 'sha-feature', pullRequestNumbers: [7, 8] })],
        pullRequests: [pullRequest(), pullRequest({ number: 8 })],
      }),
    );
    expect(keys(view)).toEqual(['pr:7', 'pr:8']);
  });

  it('drops runs without a head branch or pull request', () => {
    const view = only(repository({ runs: [run({ id: 1 }), run({ id: 2, headBranch: null })] }));
    expect(line(view, 'branch:main').runs.map((r) => r.id)).toEqual([1]);
  });
});

describe('which lines are shown', () => {
  const old = { createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:05:00Z' };
  const recent = { createdAt: '2026-11-12T13:00:00Z', updatedAt: '2026-11-12T13:00:00Z' };
  const active = { status: 'in_progress', conclusion: null, ...old };

  it('always shows the default branch and the viewer’s pull requests of a watched repository', () => {
    const view = only(
      repository({
        reasons: ['maintained'],
        runs: [
          run({ id: 1, ...old }),
          run({
            id: 2,
            headBranch: 'feature',
            headSha: 'sha-feature',
            pullRequestNumbers: [7],
            ...old,
          }),
        ],
        pullRequests: [pullRequest({ author: VIEWER.toUpperCase() })],
      }),
    );
    expect(keys(view)).toEqual(['branch:main', 'pr:7']);
  });

  it.each([
    ['active', active, true],
    ['finished within the window', recent, true],
    ['finished before the window', old, false],
  ])("shows other people's pull requests and other branches only while %s", (_, timing, shown) => {
    const view = snapshotOf(
      repository({
        runs: [
          run({ id: 1, headBranch: 'other', headSha: 'o', ...timing }),
          run({ id: 2, headBranch: 'theirs', headSha: 't', pullRequestNumbers: [9], ...timing }),
          run({ id: 3, headBranch: 'v1.0.0', headSha: 'tag', event: 'release', ...timing }),
        ],
        pullRequests: [pullRequest({ number: 9, author: 'hubot', headBranch: 'theirs' })],
      }),
    ).repositories;
    expect(views(view)).toEqual(shown ? ['branch:other', 'branch:v1.0.0', 'pr:9'] : []);
  });

  it('counts activity on older commits of the ref towards the recent window', () => {
    const view = only(
      repository({
        runs: [
          // Older commit: started three days ago, finished an hour ago.
          run({
            id: 1,
            headBranch: 'feature',
            headSha: 'old',
            createdAt: '2026-11-10T10:00:00Z',
            updatedAt: '2026-11-13T11:00:00Z',
          }),
          // Newest commit: finished two days ago.
          run({
            id: 2,
            headBranch: 'feature',
            headSha: 'new',
            createdAt: '2026-11-11T10:00:00Z',
            updatedAt: '2026-11-11T10:05:00Z',
          }),
        ],
      }),
    );
    expect(keys(view)).toEqual(['branch:feature']);
    expect(line(view, 'branch:feature').runs.map((r) => r.id)).toEqual([2]);
  });

  it.each([
    ['2026-11-12T12:00:00Z', true],
    ['2026-11-12T11:59:59Z', false],
  ])('includes the start of the recent window (updated %s → shown: %s)', (updatedAt, shown) => {
    const views = snapshotOf(
      repository({ runs: [run({ headBranch: 'other', createdAt: updatedAt, updatedAt })] }),
    ).repositories;
    expect(views).toHaveLength(shown ? 1 : 0);
  });

  it('honours the configured recent window', () => {
    const input = {
      viewer: VIEWER,
      repositories: [repository({ runs: [run({ headBranch: 'other', ...recent })] })],
      problems: [],
      rateLimit: null,
    };
    expect(buildSnapshot(input, { now: NOW, recentWindowHours: 48 }).repositories).toHaveLength(1);
    expect(buildSnapshot(input, { now: NOW, recentWindowHours: 1 }).repositories).toHaveLength(0);
  });

  it('shows only the viewer’s pull requests in a repository watched only for them', () => {
    const view = only(
      repository({
        reasons: ['my_pull_request'],
        runs: [
          run({ id: 1, status: 'in_progress', conclusion: null }),
          run({
            id: 2,
            headBranch: 'feature',
            headSha: 'sha-feature',
            pullRequestNumbers: [7],
            ...old,
          }),
          run({
            id: 3,
            headBranch: 'theirs',
            pullRequestNumbers: [9],
            status: 'queued',
            conclusion: null,
          }),
        ],
        pullRequests: [pullRequest(), pullRequest({ number: 9, author: 'hubot' })],
      }),
    );
    expect(keys(view)).toEqual(['pr:7']);
  });

  it('omits repositories without any line', () => {
    const snapshot = snapshotOf(
      repository({ fullName: 'octo-org/empty' }),
      repository({ fullName: 'octo-org/stale', runs: [run({ headBranch: 'other', ...old })] }),
      repository({
        fullName: 'octo-org/no-ci',
        reasons: ['my_pull_request'],
        pullRequests: [pullRequest()],
      }),
    );
    expect(snapshot.repositories).toEqual([]);
  });

  function views(repositories: readonly RepositoryView[]): string[] {
    return repositories.flatMap(keys);
  }
});

describe('ordering', () => {
  it('orders lines: default branch first, then newest first, then by key', () => {
    const at = (hour: string) => ({
      createdAt: `2026-11-13T${hour}:00:00Z`,
      updatedAt: `2026-11-13T${hour}:00:00Z`,
    });
    const view = only(
      repository({
        runs: [
          run({ id: 1, ...at('08') }),
          run({ id: 2, headBranch: 'b', headSha: 'b', ...at('11') }),
          run({ id: 3, headBranch: 'a', headSha: 'a', ...at('11') }),
          run({
            id: 4,
            headBranch: 'feature',
            headSha: 'sha-feature',
            pullRequestNumbers: [7],
            ...at('09'),
          }),
          run({ id: 5, headBranch: 'c', headSha: 'c', ...at('10') }),
        ],
        pullRequests: [pullRequest()],
      }),
    );
    expect(keys(view)).toEqual(['branch:main', 'branch:a', 'branch:b', 'branch:c', 'pr:7']);
  });

  it('orders repositories: active first, then most recent line, then name', () => {
    const repo = (fullName: string, createdAt: string, status = 'completed') =>
      repository({
        fullName,
        runs: [
          run({
            headRepository: fullName,
            createdAt,
            status,
            conclusion: status === 'completed' ? 'success' : null,
          }),
        ],
      });
    const snapshot = snapshotOf(
      repo('octo-org/b-quiet', '2026-11-13T11:00:00Z'),
      repo('octo-org/older-running', '2026-11-13T08:00:00Z', 'in_progress'),
      repo('Octo-Org/A-quiet', '2026-11-13T11:00:00Z'),
      repo('octo-org/newest-quiet', '2026-11-13T11:30:00Z'),
      repo('octo-org/newer-running', '2026-11-13T09:00:00Z', 'queued'),
    );
    expect(snapshot.repositories.map((r) => r.fullName)).toEqual([
      'octo-org/newer-running',
      'octo-org/older-running',
      'octo-org/newest-quiet',
      'Octo-Org/A-quiet',
      'octo-org/b-quiet',
    ]);
  });

  it('does not depend on the order of the input', () => {
    const runs = [
      run({ id: 1 }),
      run({ id: 2, workflowId: 200, workflowName: 'Lint' }),
      run({ id: 3, headBranch: 'x', headSha: 'x' }),
      run({ id: 4, headBranch: 'y', headSha: 'y' }),
      run({
        id: 5,
        headSha: 'older',
        status: 'queued',
        conclusion: null,
        createdAt: '2026-11-13T09:00:00Z',
      }),
      run({
        id: 6,
        headSha: 'oldest',
        status: 'queued',
        conclusion: null,
        createdAt: '2026-11-13T09:00:00Z',
      }),
    ];
    const gadgets = 'octo-org/gadgets';
    const repos = [
      repository({ runs }),
      repository({ fullName: gadgets, runs: runs.map((r) => ({ ...r, headRepository: gadgets })) }),
    ];
    const forward = snapshotOf(...repos);
    const backward = snapshotOf(
      ...repos.map((r) => ({ ...r, runs: [...r.runs].reverse() })).reverse(),
    );
    expect(forward.repositories.map((r) => r.lines.length)).toEqual([3, 3]);
    expect(backward).toEqual(forward);
  });
});
