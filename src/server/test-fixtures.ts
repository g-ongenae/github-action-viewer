// Synthetic snapshots and collection results for the server's tests.

import { buildSnapshot } from '../core/build-snapshot.ts';
import type { RepositoryInput, WatchReason } from '../core/inputs.ts';
import type { Problem, Snapshot } from '../core/snapshot.ts';
import { pullRequest, repository, run, VIEWER } from '../core/test-fixtures.ts';
import type { CollectionResult } from '../github/collect.ts';

export const NOW = Date.parse('2026-11-13T12:00:00Z');

export interface RepoOptions {
  readonly reasons?: readonly WatchReason[];
  /** Numbers of the viewer's open pull requests, each with a run. */
  readonly pullRequests?: readonly number[];
  /** Whether the run on the default branch is in progress. */
  readonly active?: boolean;
}

/** A repository with one run on `main` (unless only watched for pull requests) and on each PR. */
export function repo(fullName: string, options: RepoOptions = {}): RepositoryInput {
  const reasons = options.reasons ?? ['own'];
  const numbers = options.pullRequests ?? [];
  const mainRun = run({
    id: 1,
    url: `https://github.com/${fullName}/actions/runs/1`,
    headRepository: fullName,
    ...(options.active === true ? { status: 'in_progress', conclusion: null } : {}),
  });
  return repository({
    fullName,
    reasons,
    runs: [
      ...(reasons.every((reason) => reason === 'my_pull_request') ? [] : [mainRun]),
      ...numbers.map((number) =>
        run({
          id: 100 + number,
          event: 'pull_request',
          headBranch: `feature-${String(number)}`,
          headSha: `sha-${String(number)}`,
          headRepository: fullName,
          pullRequestNumbers: [number],
          url: `https://github.com/${fullName}/actions/runs/${String(100 + number)}`,
        }),
      ),
    ],
    pullRequests: numbers.map((number) =>
      pullRequest({
        number,
        url: `https://github.com/${fullName}/pull/${String(number)}`,
        headBranch: `feature-${String(number)}`,
        headSha: `sha-${String(number)}`,
        headRepository: fullName,
      }),
    ),
  });
}

export function snapshotOf(
  repositories: readonly RepositoryInput[],
  at: number = NOW,
  problems: readonly Problem[] = [],
): Snapshot {
  return buildSnapshot(
    { viewer: VIEWER, repositories, problems, rateLimit: null },
    { now: new Date(at), recentWindowHours: 24 },
  );
}

export function collection(
  snapshot: Snapshot,
  overrides: Partial<CollectionResult> = {},
): CollectionResult {
  return {
    snapshot,
    requests: { sent: 10, notModified: 10 },
    rateLimits: { core: null, search: null },
    retryAt: null,
    notRefreshed: [],
    ...overrides,
  };
}

/** Names of the repositories of a snapshot, in display order. */
export function names(snapshot: Snapshot | null): string[] {
  return snapshot?.repositories.map((repository) => repository.fullName) ?? [];
}
