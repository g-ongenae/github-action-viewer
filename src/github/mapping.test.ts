import { describe, expect, it } from 'vitest';
import { PayloadShapeError } from './json.ts';
import {
  parsePullRequestDetails,
  parsePullRequestList,
  parsePullRequestSearch,
  parseRepository,
  parseWorkflowRunList,
} from './mapping.ts';
import {
  rawPullRequest,
  rawRepository,
  rawRun,
  rawRunPullRequest,
  rawSearchItem,
} from './test-fixtures.ts';

const REPO = rawRepository('octo-org/widgets');
const FORK = rawRepository('hubot/widgets');

function mapRun(overrides: Record<string, unknown>) {
  const [run] = parseWorkflowRunList({ workflow_runs: [rawRun(REPO, overrides)] });
  return run;
}

describe('workflow runs', () => {
  it('maps the fields the core uses', () => {
    expect(mapRun({ id: 42, run_attempt: 2, status: 'in_progress', conclusion: null })).toEqual({
      id: 42,
      workflowId: 1,
      workflowName: 'CI',
      displayTitle: 'Commit title',
      event: 'push',
      status: 'in_progress',
      conclusion: null,
      headBranch: 'main',
      headSha: 'sha-main',
      headRepository: 'octo-org/widgets',
      headCommit: { message: 'Commit title\n\nBody', authorName: 'Mona Lisa' },
      pullRequestNumbers: [],
      runNumber: 42,
      runAttempt: 2,
      createdAt: '2026-11-13T10:00:00Z',
      updatedAt: '2026-11-13T10:05:00Z',
      startedAt: '2026-11-13T10:00:05Z',
      url: 'https://github.com/octo-org/widgets/actions/runs/42',
    });
  });

  it('tolerates the fields GitHub sometimes returns as null or omits', () => {
    const run = mapRun({
      name: null,
      display_title: null,
      head_branch: null,
      head_repository: null,
      head_commit: null,
      actor: null,
      pull_requests: null,
      run_attempt: undefined,
      run_started_at: undefined,
    });

    expect(run).toMatchObject({
      workflowName: '.github/workflows/ci.yml',
      displayTitle: '',
      headBranch: null,
      headRepository: null,
      headCommit: null,
      pullRequestNumbers: [],
      runAttempt: 1,
      startedAt: null,
    });
  });

  it('tolerates a head commit without message or author', () => {
    expect(mapRun({ head_commit: { id: 'sha-main' } })?.headCommit).toEqual({
      message: '',
      authorName: null,
    });
  });

  it('keeps only pull requests of the repository coming from the run branch', () => {
    const other = rawRepository('someone/widgets-fork');
    const run = mapRun({
      head_branch: 'feature',
      pull_requests: [
        rawRunPullRequest(7, { ref: 'feature', repo: REPO }, { ref: 'main', repo: REPO }),
        // A pull request of a fork that uses this repository's branch as its head.
        rawRunPullRequest(1, { ref: 'feature', repo: REPO }, { ref: 'main', repo: other }),
        // A pull request into the run's branch, not from it.
        rawRunPullRequest(9, { ref: 'other', repo: REPO }, { ref: 'feature', repo: REPO }),
      ],
    });

    expect(run?.pullRequestNumbers).toEqual([7]);
  });

  it('drops every association when the run does not say which repository it belongs to', () => {
    const run = mapRun({
      repository: null,
      head_branch: 'feature',
      pull_requests: [
        rawRunPullRequest(7, { ref: 'feature', repo: REPO }, { ref: 'main', repo: REPO }),
      ],
    });

    expect(run?.pullRequestNumbers).toEqual([]);
  });

  it('maps a run of a fork pull request', () => {
    expect(
      mapRun({ event: 'pull_request', head_repository: FORK, head_branch: 'main' }),
    ).toMatchObject({
      headRepository: 'hubot/widgets',
      headBranch: 'main',
    });
  });

  it('rejects a run without the fields it is identified by', () => {
    expect(() => mapRun({ head_sha: null })).toThrow(
      new PayloadShapeError('$.workflow_runs[0].head_sha', 'a string', null),
    );
    expect(() => mapRun({ id: '42' })).toThrow(PayloadShapeError);
    expect(() => parseWorkflowRunList({})).toThrow(PayloadShapeError);
  });
});

describe('pull requests', () => {
  it('maps a pull request', () => {
    expect(parsePullRequestList([rawPullRequest(REPO, { draft: true })])).toEqual([
      {
        number: 7,
        title: 'Add a feature',
        url: 'https://github.com/octo-org/widgets/pull/7',
        author: 'octocat',
        draft: true,
        headBranch: 'feature',
        headSha: 'sha-pr-7',
        headRepository: 'octo-org/widgets',
      },
    ]);
  });

  it('maps a pull request from a deleted fork by a deleted account', () => {
    const [pullRequest] = parsePullRequestList([
      rawPullRequest(REPO, {
        user: null,
        draft: undefined,
        head: { ref: 'patch-1', sha: 'sha-fork', repo: null },
      }),
    ]);

    expect(pullRequest).toMatchObject({ author: null, draft: false, headRepository: null });
  });

  it('reads the state and base repository of a single pull request', () => {
    const details = parsePullRequestDetails(rawPullRequest(REPO, { state: 'closed' }));

    expect(details.open).toBe(false);
    expect(details.repository).toMatchObject({
      fullName: 'octo-org/widgets',
      defaultBranch: 'main',
      url: 'https://github.com/octo-org/widgets',
    });
  });
});

describe('repositories', () => {
  it('reads the flags that decide what to fetch', () => {
    expect(parseRepository(rawRepository('octocat/x'))).toEqual({
      fullName: 'octocat/x',
      url: 'https://github.com/octocat/x',
      defaultBranch: 'main',
      pushedAt: '2026-11-13T09:00:00Z',
      inactive: false,
      hasPullRequests: true,
    });
    const quiet = parseRepository(
      rawRepository('octocat/x', { archived: true, has_pull_requests: false, pushed_at: null }),
    );
    expect(quiet).toMatchObject({ inactive: true, hasPullRequests: false, pushedAt: null });
    expect(parseRepository(rawRepository('octocat/x', { disabled: true })).inactive).toBe(true);
  });

  it('assumes pull requests are enabled when GitHub does not say', () => {
    expect(
      parseRepository(rawRepository('octocat/x', { has_pull_requests: undefined })).hasPullRequests,
    ).toBe(true);
  });
});

describe('pull request search', () => {
  it('reads the repository from the repository URL', () => {
    expect(
      parsePullRequestSearch({
        incomplete_results: false,
        items: [rawSearchItem('octo-org/widgets', 7), rawSearchItem('hubot/tools', 3)],
      }),
    ).toEqual({
      pullRequests: [
        { repository: 'octo-org/widgets', number: 7 },
        { repository: 'hubot/tools', number: 3 },
      ],
      incomplete: false,
    });
  });

  it('reports incomplete results', () => {
    expect(parsePullRequestSearch({ incomplete_results: true, items: [] }).incomplete).toBe(true);
  });

  it('rejects an item whose repository cannot be read', () => {
    expect(() =>
      parsePullRequestSearch({
        items: [{ number: 1, repository_url: 'https://api.github.com/users/octocat' }],
      }),
    ).toThrow(PayloadShapeError);
  });
});
