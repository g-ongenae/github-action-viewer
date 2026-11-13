// A scripted fake of the GitHub REST API for tests, and factories for raw API objects reduced to
// the fields the client reads. All names are synthetic.

export const TOKEN = 'ghp_test-token-never-in-messages';

export interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Answer `304` when the request carries this ETag in `If-None-Match`, else 200 with it. */
  readonly etag?: string;
}

/** A route: a fixed response, or a function of the request (to change answers over time). */
export type Route = FakeResponse | ((request: Request) => FakeResponse);

/**
 * Fake `fetch` answering from routes keyed by `pathname?search` (exact match first, then the
 * pathname alone). Unknown routes answer 404. Every request is recorded.
 */
export class FakeGitHub {
  readonly requests: Request[] = [];
  readonly #routes = new Map<string, Route>();
  /** Quota headers added to every response; `remaining` decreases on each non-304 answer. */
  remaining = 5000;

  on(key: string, route: Route): this {
    this.#routes.set(key, route);
    return this;
  }

  /** Request keys (`pathname?search`), in order. */
  get paths(): string[] {
    return this.requests.map((request) => keyOf(new URL(request.url)));
  }

  readonly fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    this.requests.push(request);
    const url = new URL(request.url);
    const route = this.#routes.get(keyOf(url)) ?? this.#routes.get(url.pathname);
    const response =
      route === undefined
        ? { status: 404, body: { message: 'Not Found' } }
        : typeof route === 'function'
          ? route(request)
          : route;
    return Promise.resolve(this.#respond(request, response));
  };

  #respond(request: Request, response: FakeResponse): Response {
    const notModified =
      response.etag !== undefined && request.headers.get('if-none-match') === response.etag;
    if (!notModified) {
      this.remaining -= 1;
    }
    const resource = new URL(request.url).pathname.startsWith('/search/') ? 'search' : 'core';
    const headers = new Headers({
      'content-type': 'application/json',
      'x-ratelimit-limit': resource === 'search' ? '30' : '5000',
      'x-ratelimit-remaining': String(this.remaining),
      'x-ratelimit-used': String(5000 - this.remaining),
      'x-ratelimit-reset': '1794600000',
      'x-ratelimit-resource': resource,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
      ...response.headers,
    });
    if (notModified) {
      return new Response(null, { status: 304, headers });
    }
    const body = response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(body, { status: response.status ?? 200, headers });
  }
}

function keyOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

let nextId = 1000;

/** A raw repository object. */
export function rawRepository(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: nextId++,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    default_branch: 'main',
    pushed_at: '2026-11-13T09:00:00Z',
    archived: false,
    disabled: false,
    has_pull_requests: true,
    ...overrides,
  };
}

/** A raw open pull request of `repository` by `octocat`, from branch `feature` of the same repo. */
export function rawPullRequest(
  repository: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const number = typeof overrides.number === 'number' ? overrides.number : 7;
  return {
    number,
    state: 'open',
    title: 'Add a feature',
    html_url: `${String(repository.html_url)}/pull/${String(number)}`,
    user: { login: 'octocat' },
    draft: false,
    head: { ref: 'feature', sha: `sha-pr-${String(number)}`, repo: repository },
    base: { ref: 'main', repo: repository },
    ...overrides,
  };
}

/** A raw finished `push` run on `main` of `repository`. */
export function rawRun(
  repository: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = typeof overrides.id === 'number' ? overrides.id : nextId++;
  return {
    id,
    workflow_id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    display_title: 'Commit title',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'sha-main',
    head_repository: repository,
    repository,
    head_commit: { message: 'Commit title\n\nBody', author: { name: 'Mona Lisa' } },
    pull_requests: [],
    run_number: id,
    run_attempt: 1,
    created_at: '2026-11-13T10:00:00Z',
    updated_at: '2026-11-13T10:05:00Z',
    run_started_at: '2026-11-13T10:00:05Z',
    html_url: `${String(repository.html_url)}/actions/runs/${String(id)}`,
    ...overrides,
  };
}

/** A `pull_requests[]` entry of a run: pull request `number` from `head` into `base`. */
export function rawRunPullRequest(
  number: number,
  head: { readonly ref: string; readonly repo: Record<string, unknown> },
  base: { readonly ref: string; readonly repo: Record<string, unknown> },
): Record<string, unknown> {
  return {
    number,
    head: { ref: head.ref, sha: 'sha', repo: { id: head.repo.id } },
    base: { ref: base.ref, sha: 'sha', repo: { id: base.repo.id } },
  };
}

/** A raw search result item for pull request `number` of `fullName`. */
export function rawSearchItem(fullName: string, number: number): Record<string, unknown> {
  return {
    number,
    repository_url: `https://api.github.com/repos/${fullName}`,
    pull_request: { url: `https://api.github.com/repos/${fullName}/pulls/${String(number)}` },
  };
}
