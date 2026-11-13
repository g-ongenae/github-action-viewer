import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../core/config.ts';
import { GitHubClient } from './client.ts';
import { collectSnapshot, RECENT_RUNS, REF_RUNS } from './collect.ts';
import { AccessDeniedError } from './errors.ts';
import {
  FakeGitHub,
  rawPullRequest,
  rawRepository,
  rawRun,
  rawRunPullRequest,
  rawSearchItem,
  TOKEN,
} from './test-fixtures.ts';

const NOW = new Date('2026-11-13T12:00:00Z');

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function clientFor(github: FakeGitHub): GitHubClient {
  return new GitHubClient({ token: TOKEN, fetch: github.fetch, now: () => NOW });
}

/** A JSON response with an ETag, so that asking again answers 304. */
function cached(body: unknown, etag = JSON.stringify(body).length.toString(36)) {
  return { body, etag: `"${etag}"` };
}

const runsOf = (...runs: unknown[]) => cached({ total_count: runs.length, workflow_runs: runs });

/**
 * The viewer `octocat` owns `widgets` (with their pull request #7 and someone else's #8),
 * `no-prs` (pull requests turned off), an archived and a dormant repository. They maintain
 * `octo-org/gadgets` (with a pull request from a fork) and `octo-org/missing` (gone), and have an
 * open pull request in `octo-org/tools`, from their fork.
 */
function scenario(): FakeGitHub {
  const widgets = rawRepository('octocat/widgets');
  const noPrs = rawRepository('octocat/no-prs', { has_pull_requests: false });
  const archived = rawRepository('octocat/archived', { archived: true });
  const dormant = rawRepository('octocat/dormant', { pushed_at: '2025-01-01T00:00:00Z' });
  const gadgets = rawRepository('octo-org/gadgets');
  const gadgetsFork = rawRepository('hubot/gadgets');
  const tools = rawRepository('octo-org/tools');
  const toolsFork = rawRepository('octocat/tools');

  return new FakeGitHub()
    .on('/user', cached({ login: 'octocat' }))
    .on('/user/repos', {
      ...cached([widgets, noPrs, archived, dormant]),
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    })
    .on('/search/issues', {
      body: {
        incomplete_results: false,
        items: [rawSearchItem('octocat/widgets', 7), rawSearchItem('octo-org/tools', 5)],
      },
    })
    .on(
      '/repos/octocat/widgets/actions/runs',
      runsOf(
        rawRun(widgets, { id: 1 }),
        rawRun(widgets, {
          id: 2,
          event: 'pull_request',
          head_branch: 'feature',
          head_sha: 'sha-pr-7',
          pull_requests: [
            rawRunPullRequest(7, { ref: 'feature', repo: widgets }, { ref: 'main', repo: widgets }),
          ],
        }),
      ),
    )
    .on(
      '/repos/octocat/widgets/pulls',
      cached([
        rawPullRequest(widgets, { number: 7 }),
        rawPullRequest(widgets, {
          number: 8,
          user: { login: 'hubot' },
          head: { ref: 'x', sha: 'sha-x', repo: widgets },
        }),
      ]),
    )
    .on('/repos/octocat/no-prs/actions/runs', runsOf(rawRun(noPrs, { id: 3 })))
    .on('/repos/octo-org/gadgets', cached(gadgets))
    .on(
      '/repos/octo-org/gadgets/actions/runs',
      runsOf(
        rawRun(gadgets, { id: 4 }),
        // A fork pull request: its branch is the fork's `main`, and GitHub associates nothing.
        rawRun(gadgets, {
          id: 5,
          event: 'pull_request',
          head_repository: gadgetsFork,
          head_branch: 'main',
          head_sha: 'sha-fork',
          status: 'in_progress',
          conclusion: null,
          updated_at: '2026-11-13T11:59:00Z',
        }),
      ),
    )
    .on(
      '/repos/octo-org/gadgets/pulls',
      cached([
        rawPullRequest(gadgets, {
          number: 3,
          user: { login: 'hubot' },
          head: { ref: 'main', sha: 'sha-fork', repo: gadgetsFork },
        }),
      ]),
    )
    .on(
      '/repos/octo-org/tools/pulls/5',
      cached(
        rawPullRequest(tools, {
          number: 5,
          head: { ref: 'fix', sha: 'sha-pr-5', repo: toolsFork },
        }),
      ),
    )
    .on(
      `/repos/octo-org/tools/actions/runs?head_sha=sha-pr-5&per_page=${String(REF_RUNS)}`,
      runsOf(
        rawRun(tools, {
          id: 6,
          event: 'pull_request',
          head_repository: toolsFork,
          head_branch: 'fix',
          head_sha: 'sha-pr-5',
        }),
      ),
    );
}

const maintained = { maintainedRepositories: ['octo-org/gadgets', 'octo-org/missing'] };

describe('collectSnapshot', () => {
  it('collects own, maintained and pull-request-only repositories', async () => {
    const github = scenario();

    const { snapshot, notRefreshed } = await collectSnapshot(
      clientFor(github),
      config(maintained),
      {
        now: NOW,
      },
    );

    const lines = Object.fromEntries(
      snapshot.repositories.map((repository) => [
        repository.fullName,
        { reasons: repository.reasons, lines: repository.lines.map((line) => line.label) },
      ]),
    );
    expect(lines).toEqual({
      'octo-org/gadgets': { reasons: ['maintained'], lines: ['main', '#3'] },
      'octo-org/tools': { reasons: ['my_pull_request'], lines: ['#5'] },
      'octocat/no-prs': { reasons: ['own'], lines: ['main'] },
      'octocat/widgets': { reasons: ['own', 'my_pull_request'], lines: ['main', '#7'] },
    });
    expect(snapshot.viewer).toBe('octocat');
    expect(snapshot.rateLimit).toEqual({
      limit: 5000,
      remaining: github.remaining,
      resetAt: '2026-11-13T20:00:00.000Z',
    });
    expect(notRefreshed).toEqual(['octo-org/missing']);
  });

  it('isolates a repository that cannot be read', async () => {
    const { snapshot } = await collectSnapshot(clientFor(scenario()), config(maintained), {
      now: NOW,
    });

    expect(snapshot.problems).toEqual([
      {
        kind: 'repository',
        repository: 'octo-org/missing',
        httpStatus: 404,
        message: expect.stringContaining('GET /repos/octo-org/missing: 404 Not Found') as string,
      },
    ]);
  });

  it('only sends the requests it needs', async () => {
    const github = scenario();

    const { requests } = await collectSnapshot(clientFor(github), config(maintained), { now: NOW });

    // No second page of repositories (the first one reaches past the push window), nothing for
    // archived or dormant repositories, no pull requests where they are turned off.
    expect(github.paths.sort()).toEqual([
      '/repos/octo-org/gadgets',
      '/repos/octo-org/gadgets/actions/runs?per_page=100',
      '/repos/octo-org/gadgets/pulls?state=open&per_page=100',
      '/repos/octo-org/missing',
      '/repos/octo-org/tools/actions/runs?head_sha=sha-pr-5&per_page=30',
      '/repos/octo-org/tools/pulls/5',
      '/repos/octocat/no-prs/actions/runs?per_page=100',
      '/repos/octocat/widgets/actions/runs?per_page=100',
      '/repos/octocat/widgets/pulls?state=open&per_page=100',
      '/search/issues?q=is%3Apr+is%3Aopen+archived%3Afalse+author%3Aoctocat&per_page=100',
      '/user',
      '/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100',
    ]);
    expect(requests).toEqual({ sent: 12, notModified: 0 });
  });

  it('costs nothing but the search when nothing changed', async () => {
    const github = scenario();
    const client = clientFor(github);
    await collectSnapshot(client, config(maintained), { now: NOW });
    const remaining = github.remaining;

    const second = await collectSnapshot(client, config(maintained), { now: NOW });

    // The viewer is not asked again; the 404 and the search have no ETag.
    expect(second.requests).toEqual({ sent: 11, notModified: 9 });
    expect(github.paths.filter((path) => path === '/user')).toHaveLength(1);
    expect(github.remaining).toBe(remaining - 2);
  });

  it('honours the switches of the configuration', async () => {
    const github = scenario();

    const { snapshot } = await collectSnapshot(
      clientFor(github),
      config({ includeOwnRepositories: false, includeMyPullRequests: false, ...maintained }),
      { now: NOW },
    );

    expect(snapshot.repositories.map((repository) => repository.fullName)).toEqual([
      'octo-org/gadgets',
    ]);
    expect(github.paths.some((path) => path.startsWith('/user/repos'))).toBe(false);
    expect(github.paths.some((path) => path.startsWith('/search/'))).toBe(false);
  });

  it('carries on without the repository list or the search when they fail', async () => {
    const github = scenario()
      .on('/user/repos', { status: 500, body: { message: 'Server Error' } })
      .on('/search/issues', { status: 422, body: { message: 'Validation Failed' } });

    const { snapshot } = await collectSnapshot(clientFor(github), config(maintained), { now: NOW });

    expect(snapshot.repositories.map((repository) => repository.fullName)).toEqual([
      'octo-org/gadgets',
    ]);
    expect(snapshot.problems.map((problem) => problem.kind)).toEqual([
      'other',
      'other',
      'repository',
    ]);
  });

  it('throws when the viewer cannot be identified', async () => {
    const github = scenario().on('/user', { status: 401, body: { message: 'Bad credentials' } });

    await expect(collectSnapshot(clientFor(github), config(), { now: NOW })).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('stops at a rate limit and keeps what it already collected', async () => {
    const github = scenario().on('/repos/octo-org/missing', {
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794590000' },
    });

    const result = await collectSnapshot(clientFor(github), config(maintained), {
      now: NOW,
      concurrency: 1,
    });

    // Repositories are collected in name order: gadgets, missing, then the others.
    expect(result.snapshot.repositories.map((repository) => repository.fullName)).toEqual([
      'octo-org/gadgets',
    ]);
    expect(result.snapshot.problems).toEqual([
      {
        kind: 'rate_limited',
        resetAt: '2026-11-13T17:13:20.000Z',
        message:
          'GitHub primary rate limit reached (core); 3 of 5 repositories were not refreshed.',
      },
    ]);
    expect(result.retryAt).toEqual(new Date('2026-11-13T17:13:20.000Z'));
    expect(result.notRefreshed).toEqual([
      'octo-org/missing',
      'octo-org/tools',
      'octocat/no-prs',
      'octocat/widgets',
    ]);
    expect(github.paths.some((path) => path.includes('octocat/widgets'))).toBe(false);
  });

  it('fetches the default branch and the viewer’s pull requests missing from a full page', async () => {
    const busy = rawRepository('octo-org/busy');
    const others = Array.from({ length: RECENT_RUNS }, (_, index) =>
      rawRun(busy, {
        id: 100 + index,
        head_branch: `branch-${String(index)}`,
        head_sha: `sha-${String(index)}`,
      }),
    );
    const github = new FakeGitHub()
      .on('/user', { body: { login: 'octocat' } })
      .on('/repos/octo-org/busy', { body: busy })
      .on('/repos/octo-org/busy/actions/runs', runsOf(...others))
      .on('/repos/octo-org/busy/pulls', { body: [rawPullRequest(busy, { number: 7 })] })
      .on(
        `/repos/octo-org/busy/actions/runs?branch=main&per_page=${String(REF_RUNS)}`,
        runsOf(rawRun(busy, { id: 1, created_at: '2026-10-01T00:00:00Z' })),
      )
      .on(
        `/repos/octo-org/busy/actions/runs?head_sha=sha-pr-7&per_page=${String(REF_RUNS)}`,
        runsOf(rawRun(busy, { id: 2, head_branch: 'feature', head_sha: 'sha-pr-7' })),
      );

    const { snapshot } = await collectSnapshot(
      clientFor(github),
      config({
        includeOwnRepositories: false,
        includeMyPullRequests: false,
        maintainedRepositories: ['octo-org/busy'],
        recentWindowHours: 0,
      }),
      { now: NOW },
    );

    expect(snapshot.repositories[0]?.lines.map((line) => line.label)).toEqual(['main', '#7']);
  });

  it('leaves out a pull request closed since the search index was updated', async () => {
    const tools = rawRepository('octo-org/tools');
    const github = new FakeGitHub()
      .on('/user', { body: { login: 'octocat' } })
      .on('/search/issues', { body: { items: [rawSearchItem('octo-org/tools', 5)] } })
      .on('/repos/octo-org/tools/pulls/5', {
        body: rawPullRequest(tools, { number: 5, state: 'closed' }),
      });

    const { snapshot, notRefreshed } = await collectSnapshot(
      clientFor(github),
      config({ includeOwnRepositories: false }),
      { now: NOW },
    );

    expect(snapshot.repositories).toEqual([]);
    expect(notRefreshed).toEqual([]);
    expect(github.paths.some((path) => path.includes('/actions/'))).toBe(false);
  });
});
