// Synthetic data for demo mode (`pnpm demo`): fictional repositories, people and runs that show
// every run state and every situation the page handles, without a token or the network. Built
// through the core's `buildSnapshot`, like real data, so it can never drift from what the server
// actually sends. Nothing here is used outside demo mode.

import { buildSnapshot } from '../core/build-snapshot.ts';
import type { PullRequestInput, RepositoryInput, WorkflowRunInput } from '../core/inputs.ts';
import type { RunState } from '../core/run-state.ts';
import type { ConfigStatus, PagePayload, ServerStatus } from '../server/payload.ts';

/**
 * - `full`: every run state and every notice at once (configuration problem, slowed-down polling,
 *   problems, a stale repository);
 * - `failing`: the same data, kept from earlier because collections now fail;
 * - `empty`: connected, but no repository has runs to show;
 * - `first-load`: the server has not collected anything yet.
 */
export const DEMO_VARIANTS = ['full', 'failing', 'empty', 'first-load'] as const;
export type DemoVariant = (typeof DEMO_VARIANTS)[number];

export const DEMO_VIEWER = 'demo-user';

/** The watch list of the demo, which its made-up editor changes (see `watch-list.ts`). */
export interface DemoWatchListState {
  /** The maintained repositories (`owner/name`). */
  readonly maintained: readonly string[];
  readonly editing: ConfigStatus['editing'];
}

/** The maintained repositories a variant starts with: those of its repositories listed as such. */
export function demoMaintained(variant: DemoVariant): string[] {
  return variant === 'full' || variant === 'failing'
    ? demoRepositories(0, 0)
        .filter((repository) => repository.reasons.includes('maintained'))
        .map((repository) => repository.fullName)
    : [];
}

const MINUTE = 60_000;

interface DemoRunSpec {
  readonly id: number;
  readonly workflow: string;
  readonly state: RunState;
  /** When the run was created, in minutes before the demo started. */
  readonly minutesAgo: number;
  readonly branch: string;
  readonly sha: string;
  readonly title: string;
  readonly author: string;
  readonly event?: string;
  readonly pullRequest?: number;
  readonly attempt?: number;
}

/** GitHub's `status` and `conclusion` for a state (the reverse of `normaliseRunState`). */
function statusOf(state: RunState): { status: string; conclusion: string | null } {
  switch (state) {
    case 'in_progress':
    case 'queued':
    case 'waiting':
      return { status: state, conclusion: null };
    case 'unknown':
      // A conclusion GitHub might add one day.
      return { status: 'completed', conclusion: 'deferred' };
    default:
      return { status: 'completed', conclusion: state };
  }
}

function demoRun(repository: string, spec: DemoRunSpec, start: number): WorkflowRunInput {
  const created = start - spec.minutesAgo * MINUTE;
  const active =
    spec.state === 'in_progress' || spec.state === 'queued' || spec.state === 'waiting';
  return {
    id: spec.id,
    workflowId: hash(spec.workflow),
    workflowName: spec.workflow,
    displayTitle: spec.title,
    event: spec.event ?? (spec.pullRequest === undefined ? 'push' : 'pull_request'),
    ...statusOf(spec.state),
    headBranch: spec.branch,
    headSha: spec.sha,
    headRepository: repository,
    headCommit: { message: `${spec.title}\n\nDemo commit body.`, authorName: spec.author },
    pullRequestNumbers: spec.pullRequest === undefined ? [] : [spec.pullRequest],
    runNumber: spec.id % 1000,
    runAttempt: spec.attempt ?? 1,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(active ? start : created + 4 * MINUTE).toISOString(),
    startedAt: spec.state === 'queued' ? null : new Date(created + 5_000).toISOString(),
    url: `https://github.com/${repository}/actions/runs/${String(spec.id)}`,
  };
}

function demoPullRequest(
  repository: string,
  pr: Omit<PullRequestInput, 'url' | 'headRepository'>,
): PullRequestInput {
  return {
    ...pr,
    url: `https://github.com/${repository}/pull/${String(pr.number)}`,
    headRepository: repository,
  };
}

function demoRepository(
  fullName: string,
  reasons: RepositoryInput['reasons'],
  runs: readonly DemoRunSpec[],
  pullRequests: readonly Omit<PullRequestInput, 'url' | 'headRepository'>[],
  start: number,
): RepositoryInput {
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    defaultBranch: 'main',
    reasons,
    runs: runs.map((spec) => demoRun(fullName, spec, start)),
    pullRequests: pullRequests.map((pr) => demoPullRequest(fullName, pr)),
  };
}

/**
 * The demo repositories as of `start`. `step` advances a little story so that the page receives
 * real updates: on odd steps the running CI of `demo-user/rocket-launcher` has finished.
 */
function demoRepositories(start: number, step: number): RepositoryInput[] {
  const launcherDone = step % 2 === 1;
  const ada = 'Ada Lovelace';
  const grace = 'Grace Hopper';
  return [
    demoRepository(
      'demo-user/rocket-launcher',
      ['own'],
      [
        {
          id: 9101,
          workflow: 'CI',
          state: launcherDone ? 'success' : 'in_progress',
          minutesAgo: 3,
          branch: 'main',
          sha: 'a1c3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9',
          title: 'Tune the ignition sequence timing',
          author: ada,
        },
        {
          id: 9102,
          workflow: 'Deploy',
          state: 'waiting',
          minutesAgo: 3,
          branch: 'main',
          sha: 'a1c3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9',
          title: 'Tune the ignition sequence timing',
          author: ada,
        },
        {
          id: 9110,
          workflow: 'CI',
          state: 'failure',
          minutesAgo: 6,
          branch: 'telemetry-backoff',
          sha: 'b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0',
          title: 'Handle 429 answers from the telemetry endpoint',
          author: DEMO_VIEWER,
          pullRequest: 482,
        },
        {
          id: 9111,
          workflow: 'Tests',
          state: 'in_progress',
          minutesAgo: 6,
          branch: 'telemetry-backoff',
          sha: 'b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0',
          title: 'Handle 429 answers from the telemetry endpoint',
          author: DEMO_VIEWER,
          pullRequest: 482,
        },
        {
          id: 9112,
          workflow: 'End-to-end',
          state: 'queued',
          minutesAgo: 6,
          branch: 'telemetry-backoff',
          sha: 'b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0',
          title: 'Handle 429 answers from the telemetry endpoint',
          author: DEMO_VIEWER,
          pullRequest: 482,
        },
        {
          id: 9120,
          workflow: 'CI',
          state: 'queued',
          minutesAgo: 1,
          branch: 'launch-window',
          sha: 'c3e5a7b9d1f3c5e7a9b1d3f5c7e9a1b3d5f7c9e1',
          title: 'Sketch a new launch-window planner',
          author: DEMO_VIEWER,
          pullRequest: 479,
        },
        {
          id: 9130,
          workflow: 'Deploy',
          state: 'waiting',
          minutesAgo: 14,
          branch: 'deploy/production',
          sha: 'd4f6b8c0e2a4d6f8b0c2e4a6d8f0b2c4e6a8d0f2',
          title: 'Release 3.2.0',
          author: grace,
          event: 'workflow_dispatch',
        },
      ],
      [
        {
          number: 482,
          title: 'Retry telemetry uploads with exponential backoff',
          author: DEMO_VIEWER,
          draft: false,
          headBranch: 'telemetry-backoff',
          headSha: 'b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0',
        },
        {
          number: 479,
          title: 'Launch-window planner',
          author: DEMO_VIEWER,
          draft: true,
          headBranch: 'launch-window',
          headSha: 'c3e5a7b9d1f3c5e7a9b1d3f5c7e9a1b3d5f7c9e1',
        },
      ],
      start,
    ),
    demoRepository(
      'acme-labs/web-console',
      ['maintained'],
      [
        // An older commit still deploying while the newest one already passed.
        {
          id: 7201,
          workflow: 'Deploy preview',
          state: 'in_progress',
          minutesAgo: 22,
          branch: 'main',
          sha: 'e5a7c9d1f3b5e7a9c1d3f5b7e9a1c3d5f7b9e1a3',
          title: 'Bump the design tokens package',
          author: 'Katherine Johnson',
        },
        {
          id: 7202,
          workflow: 'CI',
          state: 'success',
          minutesAgo: 9,
          branch: 'main',
          sha: 'f6b8d0e2a4c6f8b0d2e4a6c8f0b2d4e6a8c0f2b4',
          title: 'Fix the focus ring on the settings tabs',
          author: 'Katherine Johnson',
        },
        {
          id: 7210,
          workflow: 'CI',
          state: 'timed_out',
          minutesAgo: 48,
          branch: 'settings-validation',
          sha: 'a7c9e1f3b5d7a9c1e3f5b7d9a1c3e5f7b9d1a3c5',
          title:
            'Validate every settings field on blur, show inline errors next to the field, and keep the typed value when the reader navigates away and comes back',
          author: 'Alan Turing 🧪',
          pullRequest: 1203,
          attempt: 2,
        },
        {
          id: 7220,
          workflow: 'CI',
          state: 'action_required',
          minutesAgo: 35,
          branch: 'arabic-translation',
          sha: 'b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6',
          title: 'تحديث الترجمة العربية لصفحة الإعدادات',
          author: 'ليلى حداد',
          pullRequest: 1199,
        },
        {
          id: 7230,
          workflow: 'Release',
          state: 'cancelled',
          minutesAgo: 95,
          branch: 'release/2026.11',
          sha: 'c9e1a3b5d7f9c1e3a5b7d9f1c3e5a7b9d1f3c5e7',
          title: 'Prepare the November release',
          author: 'Margaret Hamilton',
        },
      ],
      [
        {
          number: 1203,
          title: 'Settings: validate fields on blur and keep values across navigation',
          author: 'turing-dev',
          draft: false,
          headBranch: 'settings-validation',
          headSha: 'a7c9e1f3b5d7a9c1e3f5b7d9a1c3e5f7b9d1a3c5',
        },
        {
          number: 1199,
          title: 'تحديث الترجمة العربية',
          author: 'layla-h',
          draft: false,
          headBranch: 'arabic-translation',
          headSha: 'b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6',
        },
      ],
      start,
    ),
    demoRepository(
      'demo-user/dotfiles',
      ['own'],
      [
        {
          id: 5301,
          workflow: 'Lint',
          state: 'success',
          minutesAgo: 130,
          branch: 'main',
          sha: 'd0f2b4c6e8a0d2f4b6c8e0a2d4f6b8c0e2a4d6f8',
          title: '✨ Add a starship prompt 🚀',
          author: DEMO_VIEWER,
        },
        {
          id: 5302,
          workflow: 'macOS check',
          state: 'skipped',
          minutesAgo: 130,
          branch: 'main',
          sha: 'd0f2b4c6e8a0d2f4b6c8e0a2d4f6b8c0e2a4d6f8',
          title: '✨ Add a starship prompt 🚀',
          author: DEMO_VIEWER,
        },
        {
          id: 5310,
          workflow: 'Lint',
          state: 'skipped',
          minutesAgo: 300,
          branch: 'renovate/eslint-10.x',
          sha: 'e1a3c5d7f9b1e3a5c7d9f1b3e5a7c9d1f3b5e7a9',
          title: 'chore(deps): update dependency eslint to v10',
          author: 'renovate[bot]',
        },
      ],
      [],
      start,
    ),
    demoRepository(
      'acme-labs/data-pipeline',
      ['maintained'],
      [
        {
          id: 3401,
          workflow: 'Nightly ETL',
          state: 'failure',
          minutesAgo: 190,
          branch: 'main',
          sha: 'f2b4d6e8a0c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0',
          title: 'Load the October partitions',
          author: 'Edsger Dijkstra',
          event: 'schedule',
        },
        {
          id: 3410,
          workflow: 'CI',
          state: 'stale',
          minutesAgo: 600,
          branch: 'fix/csv-encoding',
          sha: 'a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d7a9c1',
          title: 'Read CSV exports as UTF-8 with BOM',
          author: 'Barbara Liskov',
        },
      ],
      [],
      start,
    ),
    demoRepository(
      'octo-org/handbook',
      ['my_pull_request'],
      [
        {
          id: 6501,
          workflow: 'Docs',
          state: 'success',
          minutesAgo: 75,
          branch: 'webhook-retries',
          sha: 'b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2',
          title: 'Document the webhook retry policy',
          author: DEMO_VIEWER,
          pullRequest: 77,
        },
        {
          id: 6502,
          workflow: 'Link check',
          state: 'neutral',
          minutesAgo: 75,
          branch: 'webhook-retries',
          sha: 'b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2',
          title: 'Document the webhook retry policy',
          author: DEMO_VIEWER,
          pullRequest: 77,
        },
      ],
      [
        {
          number: 77,
          title: 'Document the webhook retry policy',
          author: DEMO_VIEWER,
          draft: false,
          headBranch: 'webhook-retries',
          headSha: 'b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2',
        },
      ],
      start,
    ),
    demoRepository(
      'demo-user/legacy-tools',
      ['own'],
      [
        {
          id: 2601,
          workflow: 'Audit',
          state: 'neutral',
          minutesAgo: 420,
          branch: 'main',
          sha: 'c5e7a9b1d3f5c7e9a1b3d5f7c9e1a3b5d7f9c1e3',
          title: 'Archive the old release scripts',
          author: 'John Backus',
        },
        {
          id: 2610,
          workflow: 'CI',
          state: 'unknown',
          minutesAgo: 50,
          branch: 'try/new-runner',
          sha: 'd6f8b0c2e4a6d8f0b2c4e6a8d0f2b4c6e8a0d2f4',
          title: 'Try the new ARM runners',
          author: 'John Backus',
        },
      ],
      [],
      start,
    ),
  ];
}

/**
 * `repositories` as the watch list has them: a repository removed from the maintained ones loses
 * that reason, and goes if it had no other; one added to them appears with a finished run.
 */
function withWatchList(
  repositories: readonly RepositoryInput[],
  maintained: readonly string[],
  start: number,
): RepositoryInput[] {
  const listed = new Set(maintained.map((name) => name.toLowerCase()));
  const kept = repositories.flatMap((repository) => {
    const reasons = repository.reasons.filter(
      (reason) => reason !== 'maintained' || listed.has(repository.fullName.toLowerCase()),
    );
    return reasons.length === 0 ? [] : [{ ...repository, reasons }];
  });
  const known = new Set(repositories.map((repository) => repository.fullName.toLowerCase()));
  const added = maintained
    .filter((name) => !known.has(name.toLowerCase()))
    .map((name) =>
      demoRepository(
        name,
        ['maintained'],
        [
          {
            id: 20_000 + hash(name),
            workflow: 'CI',
            state: 'success',
            minutesAgo: 2,
            branch: 'main',
            sha: 'd4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2',
            title: 'Run the tests on every push',
            author: 'Ada Lovelace',
          },
        ],
        [],
        start,
      ),
    );
  return [...kept, ...added];
}

/** A small stable number from a string (workflow ids for the demo). */
function hash(text: string): number {
  let value = 7;
  for (const char of text) {
    value = (value * 31 + (char.codePointAt(0) ?? 0)) % 100_000;
  }
  return value;
}

/**
 * The demo payload for `variant`. `start` is when the demo started (run dates are relative to
 * it, so they age naturally), `now` the current time, `step` how far the little story went, and
 * `watchList` what the reader made of the maintained repositories.
 */
export function demoPayload(
  variant: DemoVariant,
  start: number,
  now: number,
  step: number,
  watchList: DemoWatchListState = { maintained: demoMaintained(variant), editing: 'on' },
): PagePayload {
  const iso = (time: number): string => new Date(time).toISOString();
  const config: ConfigStatus = {
    state: 'ok',
    problems: null,
    fallback: null,
    maintainedRepositories: watchList.maintained,
    editing: watchList.editing,
  };
  const status: ServerStatus = {
    lastCheckedAt: iso(now - 4_000),
    lastSuccessAt: iso(now - 4_000),
    nextPollAt: iso(now + 41_000),
    stale: null,
    staleRepositories: [],
    pollInterval: { baseSeconds: 15, currentSeconds: 15, reason: 'base' },
    rateLimits: {
      core: { limit: 5000, remaining: 4210, resetAt: iso(now + 38 * MINUTE) },
      search: { limit: 30, remaining: 29, resetAt: iso(now + MINUTE) },
      retryAt: null,
    },
    config,
  };

  switch (variant) {
    case 'first-load':
      return {
        snapshot: null,
        status: {
          ...status,
          lastCheckedAt: null,
          lastSuccessAt: null,
          nextPollAt: iso(now + 2_000),
        },
      };
    case 'empty':
      return {
        snapshot: buildSnapshot(
          {
            viewer: DEMO_VIEWER,
            repositories: withWatchList([], watchList.maintained, start),
            problems: [],
            rateLimit: null,
          },
          { now: new Date(now), recentWindowHours: 24 },
        ),
        status: { ...status, config: { ...config, state: 'missing' } },
      };
    case 'full':
    case 'failing':
      break;
  }

  const snapshot = buildSnapshot(
    {
      viewer: DEMO_VIEWER,
      repositories: withWatchList(demoRepositories(start, step), watchList.maintained, start),
      problems: [
        {
          kind: 'repository',
          repository: 'acme-labs/old-dashboard',
          httpStatus: 404,
          message: 'Not found: the repository does not exist or the token cannot see it.',
        },
        {
          kind: 'other',
          message:
            'acme-labs/console in config.json is now acme-labs/web-console: update maintainedRepositories.',
        },
        {
          kind: 'other',
          message:
            'The pull request search was incomplete: some of your pull requests may be missing.',
        },
      ],
      rateLimit: null,
    },
    { now: new Date(now), recentWindowHours: 24 },
  );

  if (variant === 'failing') {
    return {
      snapshot,
      status: {
        ...status,
        lastSuccessAt: iso(start - 7 * MINUTE),
        stale: {
          reason: 'collection_failed',
          message: 'Could not reach api.github.com (network error).',
          since: iso(start - 6 * MINUTE),
        },
        pollInterval: { baseSeconds: 15, currentSeconds: 120, reason: 'backoff' },
      },
    };
  }
  return {
    snapshot,
    status: {
      ...status,
      staleRepositories: snapshot.repositories
        .filter((repository) => repository.fullName === 'acme-labs/data-pipeline')
        .map(({ fullName }) => ({ fullName, lastRefreshedAt: iso(start - 12 * MINUTE) })),
      pollInterval: { baseSeconds: 15, currentSeconds: 41, reason: 'budget' },
      // Editing stays on, unlike with a real file that has problems: it is the demo's point.
      config: {
        ...config,
        state: 'invalid',
        problems:
          'maintainedRepositories[2]: expected "owner/name", got "acme-labs"\npollIntervalSeconds: expected an integer of at least 10, got 5',
        fallback: 'last_valid',
      },
    },
  };
}
