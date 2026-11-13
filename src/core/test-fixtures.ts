// Small factories for the core's input records. All names are synthetic.

import type { PullRequestInput, RepositoryInput, WorkflowRunInput } from './inputs.ts';

export const VIEWER = 'octocat';
export const REPO = 'octo-org/widgets';
export const FORK = 'hubot/widgets';

/** A finished, successful `push` run on `main` of {@link REPO}; override what the test needs. */
export function run(overrides: Partial<WorkflowRunInput> = {}): WorkflowRunInput {
  const id = overrides.id ?? 1;
  return {
    id,
    workflowId: 100,
    workflowName: 'CI',
    displayTitle: 'Commit title',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    headSha: 'sha-main',
    headRepository: REPO,
    headCommit: { message: 'Commit title\n\nBody', authorName: 'Mona Lisa' },
    pullRequestNumbers: [],
    runNumber: id,
    runAttempt: 1,
    createdAt: '2026-11-13T10:00:00Z',
    updatedAt: '2026-11-13T10:05:00Z',
    startedAt: '2026-11-13T10:00:05Z',
    url: `https://github.com/${REPO}/actions/runs/${String(id)}`,
    ...overrides,
  };
}

/** An open pull request by {@link VIEWER} from branch `feature` of {@link REPO}. */
export function pullRequest(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  const number = overrides.number ?? 7;
  return {
    number,
    title: 'Add a feature',
    url: `https://github.com/${REPO}/pull/${String(number)}`,
    author: VIEWER,
    draft: false,
    headBranch: 'feature',
    headSha: 'sha-feature',
    headRepository: REPO,
    ...overrides,
  };
}

/** {@link REPO}, owned by the viewer, without runs or pull requests. */
export function repository(overrides: Partial<RepositoryInput> = {}): RepositoryInput {
  const fullName = overrides.fullName ?? REPO;
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    defaultBranch: 'main',
    reasons: ['own'],
    runs: [],
    pullRequests: [],
    ...overrides,
  };
}
