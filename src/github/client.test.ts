import { describe, expect, it } from 'vitest';
import { API_VERSION, GitHubClient, MAX_PAGES, MAX_REDIRECTS, nextPageUrl } from './client.ts';
import {
  AccessDeniedError,
  HttpError,
  MalformedTokenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  UnexpectedPayloadError,
} from './errors.ts';
import { ObjectReader } from './json.ts';
import { FakeGitHub, TOKEN, type FakeResponse } from './test-fixtures.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const identity = (body: unknown): unknown => body;
const login = (body: unknown): string => new ObjectReader(body, '$').string('login');

function setup(options: { cacheMaxChars?: number; timeoutMs?: number } = {}) {
  const github = new FakeGitHub();
  const client = new GitHubClient({
    token: TOKEN,
    fetch: github.fetch,
    now: () => NOW,
    ...options,
  });
  return { github, client };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      expect(error.message).not.toContain(TOKEN);
      return error;
    }
    throw new Error('rejected with a non-error', { cause: error });
  }
  throw new Error('expected a rejection');
}

describe('GitHubClient requests', () => {
  it('sends a GET with the documented headers', async () => {
    const { github, client } = setup();
    github.on('/user', { body: { login: 'octocat' } });

    await expect(client.get('/user', {}, login)).resolves.toBe('octocat');

    const [request] = github.requests;
    expect(request?.method).toBe('GET');
    expect(request?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get('x-github-api-version')).toBe(API_VERSION);
    expect(request?.headers.get('user-agent')).toBe('github-action-viewer');
  });

  it('encodes the query', async () => {
    const { github, client } = setup();
    github.on('/search/issues', { body: {} });

    await client.get('/search/issues', { q: 'is:pr author:octocat', per_page: 100 }, identity);

    expect(github.paths).toEqual(['/search/issues?q=is%3Apr+author%3Aoctocat&per_page=100']);
  });

  it.each(['//example.com/x', 'user', '/\\example.com/x', '/\\\\example.com/x', '/\t/example.com'])(
    'refuses %j, which could leave the API, before sending anything',
    async (path) => {
      const { github, client } = setup();
      await expect(client.get(path, {}, identity)).rejects.toThrow(TypeError);
      expect(github.requests).toHaveLength(0);
    },
  );

  it('refuses a malformed token up front, without echoing it', () => {
    for (const token of ['', 'ghp_abc\ndef', 'ghp_abc def', 'ghp_\u0000x', 'ghp_é']) {
      expect(() => new GitHubClient({ token })).toThrow(MalformedTokenError);
      try {
        new GitHubClient({ token });
      } catch (error) {
        expect(String(error)).not.toContain(token === '' ? 'never' : token);
      }
    }
  });
});

describe('GitHubClient redirects', () => {
  const moved = (location: string): FakeResponse => ({
    status: 301,
    body: { message: 'Moved Permanently' },
    headers: { location },
  });

  it('handles redirects itself', async () => {
    const { github, client } = setup();
    github.on('/user', { body: { login: 'octocat' } });

    await client.get('/user', {}, login);

    expect(github.requests[0]?.redirect).toBe('manual');
  });

  it('follows a redirect within the API, as for a renamed repository', async () => {
    const { github, client } = setup();
    github.on('/repos/octo-org/old-name', moved('https://api.github.com/repositories/42'));
    github.on('/repositories/42', { body: { login: 'renamed' }, etag: '"r"' });

    await expect(client.get('/repos/octo-org/old-name', {}, login)).resolves.toBe('renamed');
    await expect(client.get('/repos/octo-org/old-name', {}, login)).resolves.toBe('renamed');

    expect(github.paths).toEqual([
      '/repos/octo-org/old-name',
      '/repositories/42',
      '/repos/octo-org/old-name',
      '/repositories/42',
    ]);
    expect(github.requests.every((r) => r.headers.get('authorization') === `Bearer ${TOKEN}`)).toBe(
      true,
    );
    expect(github.requests[3]?.headers.get('if-none-match')).toBe('"r"');
    expect(client.stats).toEqual({ requests: 4, notModified: 1 });
  });

  it.each([
    'https://example.com/repositories/42',
    'http://api.github.com/repositories/42',
    'https://user:secret@api.github.com/repositories/42',
    '/\\example.com/x',
  ])('refuses a redirect to %s', async (location) => {
    const { github, client } = setup();
    github.on('/repos/o/r', moved(location));

    const error = await failure(client.get('/repos/o/r', {}, identity));

    expect(error).toBeInstanceOf(UnexpectedPayloadError);
    expect(github.requests).toHaveLength(1);
  });

  it('gives up after a few redirects', async () => {
    const { github, client } = setup();
    github.on('/loop', moved('https://api.github.com/loop'));

    expect(await failure(client.get('/loop', {}, identity))).toBeInstanceOf(HttpError);
    expect(github.requests).toHaveLength(MAX_REDIRECTS + 1);
  });
});

describe('GitHubClient conditional requests', () => {
  it('sends the ETag back and serves a 304 from the cache, for free', async () => {
    const { github, client } = setup();
    github.on('/user', { body: { login: 'octocat' }, etag: '"v1"' });

    await client.get('/user', {}, login);
    const used = client.rateLimit('core')?.used;
    await expect(client.get('/user', {}, login)).resolves.toBe('octocat');

    expect(github.requests[0]?.headers.get('if-none-match')).toBeNull();
    expect(github.requests[1]?.headers.get('if-none-match')).toBe('"v1"');
    expect(client.stats).toEqual({ requests: 2, notModified: 1 });
    expect(client.rateLimit('core')?.used).toBe(used);
  });

  it('replaces the cached body when the resource changes', async () => {
    const { github, client } = setup();
    let version = 1;
    github.on('/user', () => ({
      body: { login: `octocat-${String(version)}` },
      etag: `"v${String(version)}"`,
    }));

    await client.get('/user', {}, login);
    version = 2;
    await expect(client.get('/user', {}, login)).resolves.toBe('octocat-2');
    await expect(client.get('/user', {}, login)).resolves.toBe('octocat-2');
    expect(github.requests[2]?.headers.get('if-none-match')).toBe('"v2"');
  });

  it('keys the cache by URL, query included', async () => {
    const { github, client } = setup();
    github.on('/repos/o/r/actions/runs', (request) => ({
      body: { url: request.url },
      etag: `"${new URL(request.url).search}"`,
    }));

    await client.get('/repos/o/r/actions/runs', { branch: 'main' }, identity);
    await client.get('/repos/o/r/actions/runs', { branch: 'dev' }, identity);

    expect(github.requests[1]?.headers.get('if-none-match')).toBeNull();
  });

  it('evicts the least recently used entries beyond its size bound', async () => {
    // Each body is about 20 characters: the cache holds two of them.
    const { github, client } = setup({ cacheMaxChars: 45 });
    for (const name of ['a', 'b', 'c']) {
      github.on(`/users/${name}`, { body: { login: `user-${name}` }, etag: `"${name}"` });
    }

    await client.get('/users/a', {}, login);
    await client.get('/users/b', {}, login);
    await client.get('/users/a', {}, login); // a is now the most recently used
    await client.get('/users/c', {}, login); // evicts b
    await client.get('/users/a', {}, login);
    await client.get('/users/b', {}, login);

    const conditional = github.requests.map((r) => r.headers.get('if-none-match'));
    expect(conditional).toEqual([null, null, '"a"', null, '"a"', null]);
  });
});

describe('GitHubClient pagination', () => {
  const link = (page: number): Readonly<Record<string, string>> => ({
    link: `<https://api.github.com/items?page=${String(page)}>; rel="next", <https://api.github.com/items?page=99>; rel="last"`,
  });
  const pages = (count: number): Record<string, FakeResponse> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const page = index + 1;
        const key = page === 1 ? '/items' : `/items?page=${String(page)}`;
        return [key, { body: [page], headers: page < count ? link(page + 1) : {} }];
      }),
    );

  async function collect(client: GitHubClient, maxPages: number) {
    const seen: { data: unknown; hasNext: boolean }[] = [];
    for await (const page of client.pages('/items', {}, identity, { maxPages })) {
      seen.push(page);
    }
    return seen;
  }

  it('follows the next links until the last page', async () => {
    const { github, client } = setup();
    for (const [key, response] of Object.entries(pages(3))) {
      github.on(key, response);
    }

    expect(await collect(client, 10)).toEqual([
      { data: [1], hasNext: true },
      { data: [2], hasNext: true },
      { data: [3], hasNext: false },
    ]);
  });

  it('stops at the page cap and says more pages exist', async () => {
    const { github, client } = setup();
    for (const [key, response] of Object.entries(pages(MAX_PAGES + 5))) {
      github.on(key, response);
    }

    const twoPages = await collect(client, 2);
    expect(twoPages.map((page) => page.data)).toEqual([[1], [2]]);
    expect(twoPages.at(-1)?.hasNext).toBe(true);
    expect(await collect(client, 1000)).toHaveLength(MAX_PAGES);
  });

  it('keeps the links of a page served from the cache', async () => {
    const { github, client } = setup();
    github.on('/items', { body: [1], headers: link(2), etag: '"p1"' });
    github.on('/items?page=2', { body: [2] });

    await collect(client, 10);
    expect(await collect(client, 10)).toHaveLength(2);
    expect(github.paths).toEqual(['/items', '/items?page=2', '/items', '/items?page=2']);
  });

  it('refuses a next link outside the API', () => {
    expect(() =>
      nextPageUrl('GET /items', '<https://example.com/items?page=2>; rel="next"'),
    ).toThrow(UnexpectedPayloadError);
  });

  it('reads the next link among others, and none when absent', () => {
    expect(
      nextPageUrl(
        'GET /items',
        '<https://api.github.com/items?page=1>; rel="prev", <https://api.github.com/items?page=3>; rel="next"',
      )?.href,
    ).toBe('https://api.github.com/items?page=3');
    expect(
      nextPageUrl('GET /items', '<https://api.github.com/items?page=1>; rel="prev"'),
    ).toBeNull();
    expect(nextPageUrl('GET /items', null)).toBeNull();
  });
});

describe('GitHubClient rate limits', () => {
  it('records the quota of each resource', async () => {
    const { github, client } = setup();
    github.on('/user', { body: { login: 'octocat' } });
    github.on('/search/issues', { body: { items: [] } });

    expect(client.rateLimit('core')).toBeNull();
    await client.get('/user', {}, login);
    await client.get('/search/issues', {}, identity);

    expect(client.rateLimit('core')).toEqual({
      resource: 'core',
      limit: 5000,
      remaining: 4999,
      used: 1,
      resetAt: new Date(1_794_600_000_000),
    });
    expect(client.rateLimit('search')?.limit).toBe(30);
  });

  it('maps an exhausted quota to a primary rate limit until the reset', async () => {
    const { github, client } = setup();
    github.on('/user', {
      status: 403,
      body: { message: 'API rate limit exceeded for user ID 1.' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794590000' },
    });

    const error = await failure(client.get('/user', {}, login));

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({
      kind: 'primary',
      resource: 'core',
      status: 403,
      retryAt: new Date(1_794_590_000_000),
    });
  });

  it('maps retry-after to a secondary rate limit', async () => {
    const { github, client } = setup();
    github.on('/user', {
      status: 429,
      body: { message: 'You have exceeded a secondary rate limit.' },
      headers: { 'retry-after': '30' },
    });

    expect(await failure(client.get('/user', {}, login))).toMatchObject({
      kind: 'secondary',
      status: 429,
      retryAt: new Date(NOW.getTime() + 30_000),
    });
  });

  it('waits a minute for a secondary rate limit without headers', async () => {
    const { github, client } = setup();
    github.on('/user', {
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
    });

    expect(await failure(client.get('/user', {}, login))).toMatchObject({
      kind: 'secondary',
      retryAt: new Date(NOW.getTime() + 60_000),
    });
  });
});

describe('GitHubClient errors', () => {
  it.each([
    [404, NotFoundError],
    [401, AccessDeniedError],
    [403, AccessDeniedError],
    [422, HttpError],
    [502, HttpError],
  ])('maps %i to %o', async (status, type) => {
    const { github, client } = setup();
    github.on('/repos/o/r', { status, body: { message: 'Nope' } });

    const error = await failure(client.get('/repos/o/r', {}, identity));

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ status, request: 'GET /repos/o/r' });
    expect(error.message).toBe(`GET /repos/o/r: ${String(status)} Nope`);
  });

  it('maps a failed fetch to a network error keeping only its error code', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetch: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
          }),
        ),
    });

    const error = await failure(client.get('/user', {}, login));

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ status: null, timedOut: false, code: 'ECONNRESET' });
    expect(error.message).toBe('GET /user: network error (ECONNRESET)');
  });

  it('drops the text and cause of a fetch error, which can quote request headers', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetch: () =>
        Promise.reject(
          new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`, {
            cause: Object.assign(new Error(`invalid value Bearer ${TOKEN}`), { code: TOKEN }),
          }),
        ),
    });

    const error = await failure(client.get('/user', {}, login));

    expect(error.message).toBe('GET /user: network error');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(Object.entries(error))).not.toContain(TOKEN);
  });

  it('times out', async () => {
    const client = new GitHubClient({ token: TOKEN, timeoutMs: 5, fetch: hangUntilAborted });

    const error = await failure(client.get('/user', {}, login));

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ timedOut: true, message: 'GET /user: request timed out' });
  });

  it('rethrows the reason of an abort by the caller', async () => {
    const client = new GitHubClient({ token: TOKEN, fetch: hangUntilAborted });
    const controller = new AbortController();
    const reason = new Error('shutting down');

    const pending = client.get('/user', {}, login, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('rejects a body that is not JSON', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      fetch: () => Promise.resolve(new Response('<html>', { status: 200 })),
    });

    expect(await failure(client.get('/user', {}, login))).toBeInstanceOf(UnexpectedPayloadError);
  });

  it('turns a parser failure into an unexpected-payload error naming the field', async () => {
    const { github, client } = setup();
    github.on('/user', { body: { login: null } });

    const error = await failure(client.get('/user', {}, login));

    expect(error).toBeInstanceOf(UnexpectedPayloadError);
    expect(error.message).toBe('GET /user: expected a string at $.login, got null');
  });

  it('does not cache a response that failed to parse', async () => {
    const { github, client } = setup();
    github.on('/user', { body: {}, etag: '"bad"' });

    await failure(client.get('/user', {}, login));
    await failure(client.get('/user', {}, login));

    expect(github.requests[1]?.headers.get('if-none-match')).toBeNull();
  });
});

/** A fetch that never answers, and rejects with the signal's reason once aborted. */
function hangUntilAborted(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error);
    });
  });
}
