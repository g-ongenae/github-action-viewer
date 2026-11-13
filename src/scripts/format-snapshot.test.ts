import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../core/build-snapshot.ts';
import { pullRequest, repository, run } from '../core/test-fixtures.ts';
import type { CollectionResult } from '../github/collect.ts';
import { formatCollection } from './format-snapshot.ts';

const NOW = new Date('2026-11-13T12:00:00Z');

describe('formatCollection', () => {
  it('prints one line per ref, then the problems and the cost', () => {
    const snapshot = buildSnapshot(
      {
        viewer: 'octocat',
        repositories: [
          repository({
            runs: [
              run({ id: 1 }),
              run({
                id: 2,
                headBranch: 'feature',
                headSha: 'sha-feature',
                status: 'in_progress',
                conclusion: null,
              }),
            ],
            pullRequests: [pullRequest({ draft: true })],
          }),
          repository({
            fullName: 'octo-org/gadgets',
            runs: [
              run({
                id: 3,
                headRepository: 'octo-org/gadgets',
                headSha: 'sha-old',
                status: 'in_progress',
                conclusion: null,
              }),
              run({
                id: 4,
                headRepository: 'octo-org/gadgets',
                headSha: 'sha-new',
                conclusion: 'failure',
                createdAt: '2026-11-13T11:00:00Z',
              }),
            ],
          }),
        ],
        problems: [
          {
            kind: 'repository',
            repository: 'octo-org/gone',
            httpStatus: 404,
            message: 'Not found.',
          },
        ],
        rateLimit: null,
      },
      { now: NOW, recentWindowHours: 24 },
    );
    const result: CollectionResult = {
      snapshot,
      requests: { sent: 10, notModified: 8 },
      rateLimits: {
        core: { resource: 'core', limit: 5000, remaining: 4990, used: 10, resetAt: NOW },
        search: null,
      },
      retryAt: null,
      notRefreshed: ['octo-org/gone'],
    };

    expect(formatCollection(result)).toBe(
      [
        'GitHub Actions of octocat — 2026-11-13 12:00Z',
        '! octo-org/gone: Not found.',
        '',
        'octo-org/gadgets  (own)',
        '  [in_progress, latest commit failure] main  2026-11-13 11:00Z  Commit title - Mona Lisa',
        '',
        'octo-org/widgets  (own)',
        '  [success] main  2026-11-13 10:00Z  Commit title - Mona Lisa',
        '  [in_progress] #7 Add a feature (draft) by octocat  2026-11-13 10:00Z  Commit title - Mona Lisa',
        '',
        '10 requests (8 not modified, 2 counted) · core 4990/5000 left until 2026-11-13 12:00Z',
      ].join('\n'),
    );
  });
});
