import { describe, expect, it } from 'vitest';
import { collectNotices, emptyState } from './notices.ts';
import { iso, NOW, payload, repositoryView, lineView, snapshot, status } from './test-fixtures.ts';

describe('collectNotices', () => {
  it('has nothing to say about a healthy payload', () => {
    expect(collectNotices(payload([]), NOW)).toEqual([]);
    expect(collectNotices(null, NOW)).toEqual([]);
  });

  it('shows the configuration problems verbatim, one per line', () => {
    const [notice] = collectNotices(
      payload([], {
        config: {
          state: 'invalid',
          problems: 'port: bad\npollIntervalSeconds: bad',
          fallback: 'defaults',
        },
      }),
      NOW,
    );
    expect(notice).toMatchObject({
      key: 'config',
      title: 'The configuration file has problems: the defaults apply.',
      details: ['port: bad', 'pollIntervalSeconds: bad'],
      verbatim: true,
    });
  });

  it('says how old stale data is, why, and since when', () => {
    const [notice] = collectNotices(
      payload([], {
        lastSuccessAt: iso(12),
        stale: {
          reason: 'collection_failed',
          message: 'GitHub rejected the token.',
          since: iso(10),
        },
      }),
      NOW,
    );
    expect(notice?.title).toBe('Showing data from 12 min ago: the latest checks failed.');
    expect(notice?.details).toEqual([
      'GitHub rejected the token.',
      'Failing since 10 min ago, next attempt in 15 s.',
    ]);
  });

  it('explains slowed-down polling with the quota', () => {
    const [notice] = collectNotices(
      payload([], {
        pollInterval: { baseSeconds: 15, currentSeconds: 41, reason: 'budget' },
        rateLimits: {
          core: { limit: 5000, remaining: 900, resetAt: iso(-30) },
          search: null,
          retryAt: null,
        },
      }),
      NOW,
    );
    expect(notice?.tone).toBe('info');
    expect(notice?.title).toBe(
      'Checking every 41 s instead of every 15 s, to save GitHub API quota.',
    );
    expect(notice?.details[0]).toMatch(/^900 of 5000 requests left until /);
  });

  it('says when a rate limit holds the page', () => {
    const [notice] = collectNotices(
      payload([], {
        pollInterval: { baseSeconds: 15, currentSeconds: 600, reason: 'rate_limited' },
        rateLimits: { core: null, search: null, retryAt: iso(-10) },
      }),
      NOW,
    );
    expect(notice?.title).toBe(
      'GitHub’s rate limit was reached: the page is not refreshed until it lifts (in 10 min).',
    );
  });

  it('lists the problems of the snapshot', () => {
    const notices = collectNotices(
      {
        snapshot: snapshot([], {
          problems: [
            { kind: 'repository', repository: 'o/gone', httpStatus: 404, message: 'Not found' },
            { kind: 'other', message: 'Search incomplete' },
          ],
        }),
        status: status(),
      },
      NOW,
    );
    expect(notices.map((notice) => [notice.title, notice.details])).toEqual([
      ['o/gone could not be read.', ['Not found (HTTP 404)']],
      ['Search incomplete', []],
    ]);
  });
});

describe('emptyState', () => {
  it('says it is connecting, then that the server is unreachable', () => {
    expect(emptyState(null, 'connecting')?.key).toBe('connecting');
    expect(emptyState(null, 'disconnected')?.key).toBe('unreachable');
  });

  it('waits for the first collection', () => {
    expect(emptyState(payload(null), 'live')?.key).toBe('first-collection');
  });

  it('explains what is watched when there is nothing to show, pointing to config.json', () => {
    const state = emptyState(
      payload([], { config: { state: 'missing', problems: null, fallback: null } }),
      'live',
    );
    expect(state?.key).toBe('no-repositories');
    expect(JSON.stringify(state)).toContain('"code":"config.json"');
    expect(JSON.stringify(state)).toContain('There is no ');
  });

  it('is null when there are repositories', () => {
    expect(emptyState(payload([repositoryView('o/r', [lineView()])]), 'live')).toBeNull();
  });
});
