// Raw REST API objects → the core's input records (src/core/inputs.ts). Only the fields used are
// read; see ./json.ts for how missing and null values are treated.

import type { PullRequestInput, WorkflowRunInput } from '../core/inputs.ts';
import { isRepositoryName } from '../core/repository-name.ts';
import { ObjectReader, PayloadShapeError, readObjects } from './json.ts';

/** What the collector needs to know about a repository. */
export interface RepositoryInfo {
  readonly fullName: string;
  readonly url: string;
  readonly defaultBranch: string;
  /** `pushed_at`; null for an empty repository. */
  readonly pushedAt: string | null;
  /** Archived or disabled: no new runs can appear. */
  readonly inactive: boolean;
  /** False when pull requests are turned off for the repository (its `/pulls` answers 404). */
  readonly hasPullRequests: boolean;
}

/** A pull request found by the search API. */
export interface PullRequestReference {
  /** `owner/name` of the repository the pull request is in. */
  readonly repository: string;
  readonly number: number;
}

/** `GET /user`: the login of the viewer. */
export function parseViewer(body: unknown): string {
  return new ObjectReader(body, '$').string('login');
}

/** A repository object (`GET /repos/{owner}/{repo}`, `GET /user/repos`, a PR's `base.repo`). */
export function toRepositoryInfo(repository: ObjectReader): RepositoryInfo {
  return {
    fullName: repository.string('full_name'),
    url: repository.string('html_url'),
    defaultBranch: repository.string('default_branch'),
    pushedAt: repository.optionalString('pushed_at'),
    inactive:
      repository.optionalBoolean('archived') === true ||
      repository.optionalBoolean('disabled') === true,
    hasPullRequests: repository.optionalBoolean('has_pull_requests') !== false,
  };
}

export function parseRepository(body: unknown): RepositoryInfo {
  return toRepositoryInfo(new ObjectReader(body, '$'));
}

export function parseRepositoryList(body: unknown): RepositoryInfo[] {
  return readObjects(body).map(toRepositoryInfo);
}

/** A page of `GET /search/issues`. */
export interface SearchPage {
  readonly pullRequests: PullRequestReference[];
  /** GitHub's `incomplete_results`: the search timed out and the list may lack some items. */
  readonly incomplete: boolean;
}

export function parsePullRequestSearch(body: unknown): SearchPage {
  const page = new ObjectReader(body, '$');
  return {
    pullRequests: page.objects('items').map((item) => {
      // `repository_url` is `https://api.github.com/repos/{owner}/{repo}`.
      const url = item.string('repository_url');
      const repository = /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1] ?? '';
      if (!isRepositoryName(repository)) {
        throw new PayloadShapeError(`${item.path}.repository_url`, 'a repository API URL', url);
      }
      return { repository, number: item.integer('number') };
    }),
    incomplete: page.optionalBoolean('incomplete_results') === true,
  };
}

/** A pull request object (`GET …/pulls`, `GET …/pulls/{number}`). */
export function toPullRequestInput(pullRequest: ObjectReader): PullRequestInput {
  const head = pullRequest.object('head');
  return {
    number: pullRequest.integer('number'),
    title: pullRequest.optionalString('title') ?? '',
    url: pullRequest.string('html_url'),
    author: pullRequest.optionalObject('user')?.optionalString('login') ?? null,
    draft: pullRequest.optionalBoolean('draft') === true,
    headBranch: head.string('ref'),
    headSha: head.string('sha'),
    // Null when the fork the pull request comes from was deleted.
    headRepository: head.optionalObject('repo')?.optionalString('full_name') ?? null,
  };
}

export function parsePullRequestList(body: unknown): PullRequestInput[] {
  return readObjects(body).map(toPullRequestInput);
}

/** `GET …/pulls/{number}`: the pull request, whether it is open, and its base repository. */
export interface PullRequestDetails {
  readonly pullRequest: PullRequestInput;
  readonly open: boolean;
  readonly repository: RepositoryInfo;
}

export function parsePullRequestDetails(body: unknown): PullRequestDetails {
  const pullRequest = new ObjectReader(body, '$');
  return {
    pullRequest: toPullRequestInput(pullRequest),
    open: pullRequest.optionalString('state') === 'open',
    repository: toRepositoryInfo(pullRequest.object('base').object('repo')),
  };
}

/** A page of `GET …/actions/runs`. */
export function parseWorkflowRunList(body: unknown): WorkflowRunInput[] {
  return new ObjectReader(body, '$').objects('workflow_runs').map(toWorkflowRunInput);
}

/** A workflow run object. */
export function toWorkflowRunInput(run: ObjectReader): WorkflowRunInput {
  const headCommit = run.optionalObject('head_commit');
  return {
    id: run.integer('id'),
    workflowId: run.integer('workflow_id'),
    workflowName: run.optionalString('name') ?? run.optionalString('path') ?? 'Workflow',
    displayTitle: run.optionalString('display_title') ?? '',
    event: run.string('event'),
    status: run.optionalString('status'),
    conclusion: run.optionalString('conclusion'),
    headBranch: run.optionalString('head_branch'),
    headSha: run.string('head_sha'),
    headRepository: run.optionalObject('head_repository')?.optionalString('full_name') ?? null,
    headCommit: headCommit && {
      message: headCommit.optionalString('message') ?? '',
      authorName: headCommit.optionalObject('author')?.optionalString('name') ?? null,
    },
    pullRequestNumbers: ownPullRequestNumbers(run),
    runNumber: run.integer('run_number'),
    runAttempt: run.optionalInteger('run_attempt') ?? 1,
    createdAt: run.string('created_at'),
    updatedAt: run.string('updated_at'),
    startedAt: run.optionalString('run_started_at'),
    url: run.string('html_url'),
  };
}

/**
 * The numbers of `pull_requests[]` that are pull requests *of the run's repository* coming from
 * the run's branch. GitHub also lists pull requests of other repositories there, typically forks
 * whose pull requests use this repository's branch as their head or base: a scheduled run on
 * `main` of a popular repository can list dozens of them. Their numbers mean nothing here and
 * would collide with local ones. The head-branch check is defensive: every same-repository entry
 * observed matched it.
 */
function ownPullRequestNumbers(run: ObjectReader): number[] {
  const repositoryId = run.optionalObject('repository')?.optionalInteger('id') ?? null;
  const headBranch = run.optionalString('head_branch');
  if (repositoryId === null || headBranch === null) {
    return [];
  }
  return run
    .optionalObjects('pull_requests')
    .filter(
      (pr) =>
        pr.optionalObject('base')?.optionalObject('repo')?.optionalInteger('id') === repositoryId &&
        pr.optionalObject('head')?.optionalString('ref') === headBranch,
    )
    .flatMap((pr) => {
      const number = pr.optionalInteger('number');
      return number === null ? [] : [number];
    });
}
