// Input records of the core: what the GitHub client (src/github/) collects and maps from the REST
// API before the core turns it into a snapshot. They follow what GitHub provides but not its JSON
// shape. Dates are ISO 8601 strings as GitHub returns them; repository names are `owner/name`.

/** Why a repository is on the page. A repository can have several reasons at once. */
export type WatchReason =
  /** The viewer owns it. */
  | 'own'
  /** It is on the maintained list of the configuration. */
  | 'maintained'
  /** The viewer has an open pull request there. */
  | 'my_pull_request';

/** One workflow run, from "List workflow runs for a repository". */
export interface WorkflowRunInput {
  /** `id`. */
  readonly id: number;
  /** `workflow_id`: runs of the same workflow share it. */
  readonly workflowId: number;
  /** `name` (the workflow's name), falling back to `path` when GitHub returns no name. */
  readonly workflowName: string;
  /** `display_title`: the commit title for pushes, the pull request title for PR events. */
  readonly displayTitle: string;
  /** `event`, e.g. `push`, `pull_request`, `schedule`, `workflow_dispatch`. */
  readonly event: string;
  /** `status`, kept raw (see `normaliseRunState`). */
  readonly status: string | null;
  /** `conclusion`, kept raw (see `normaliseRunState`). */
  readonly conclusion: string | null;
  /** `head_branch`: branch (or tag) name; null for a few events. */
  readonly headBranch: string | null;
  /** `head_sha`. */
  readonly headSha: string;
  /** `head_repository.full_name`: differs from the repository for runs of fork pull requests. */
  readonly headRepository: string | null;
  /** `head_commit`, when GitHub returns it. */
  readonly headCommit: HeadCommitInput | null;
  /**
   * Numbers from `pull_requests[]`: the open pull requests GitHub associates with the run. Empty
   * for pull requests from forks.
   */
  readonly pullRequestNumbers: readonly number[];
  /** `run_number`: increases with each run of the same workflow. */
  readonly runNumber: number;
  /** `run_attempt`: 1, then 2, 3… for re-runs. */
  readonly runAttempt: number;
  /** `created_at`. */
  readonly createdAt: string;
  /** `updated_at`. */
  readonly updatedAt: string;
  /** `run_started_at` (start of the latest attempt), when present. */
  readonly startedAt: string | null;
  /** `html_url`. */
  readonly url: string;
}

/** The head commit of a run (`head_commit`). */
export interface HeadCommitInput {
  /** `message`, in full. */
  readonly message: string;
  /** `author.name`: the git author name, not a GitHub login. */
  readonly authorName: string | null;
}

/** One open pull request, from "List pull requests" or the search API. */
export interface PullRequestInput {
  /** `number`. */
  readonly number: number;
  /** `title`. */
  readonly title: string;
  /** `html_url`. */
  readonly url: string;
  /** `user.login`; null if GitHub returns no user (deleted account). */
  readonly author: string | null;
  /** `draft`. */
  readonly draft: boolean;
  /** `head.ref`: the branch the pull request comes from. */
  readonly headBranch: string;
  /** `head.sha`: the newest commit of the pull request. */
  readonly headSha: string;
  /** `head.repo.full_name`: a fork for fork pull requests; null when the fork was deleted. */
  readonly headRepository: string | null;
}

/** One repository with everything collected about it. */
export interface RepositoryInput {
  /** `full_name`, e.g. `octo-org/widgets`. */
  readonly fullName: string;
  /** `html_url`. */
  readonly url: string;
  /** `default_branch`. */
  readonly defaultBranch: string;
  /** Why the repository is watched; never empty. */
  readonly reasons: readonly WatchReason[];
  /** Recent workflow runs, in any order. */
  readonly runs: readonly WorkflowRunInput[];
  /**
   * Open pull requests: all of them for a repository the viewer owns or maintains, at least the
   * viewer's own for the others.
   */
  readonly pullRequests: readonly PullRequestInput[];
}
