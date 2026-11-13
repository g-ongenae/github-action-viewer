import {
  AccessDeniedError,
  HttpError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  UnexpectedPayloadError,
} from './errors.ts';
import { PayloadShapeError } from './json.ts';

/** REST API version sent with every request (https://docs.github.com/en/rest/about-the-rest-api/api-versions). */
export const API_VERSION = '2026-03-10';

const API_ORIGIN = 'https://api.github.com';

/** Upper bound of {@link PageOptions.maxPages}, whatever the caller asks for. */
export const MAX_PAGES = 10;

/** Quota of one rate-limit resource, from the `x-ratelimit-*` headers of its latest response. */
export interface RateLimitStatus {
  /** `x-ratelimit-resource`: `core`, `search`… Each resource has its own quota. */
  readonly resource: string;
  readonly limit: number;
  readonly remaining: number;
  readonly used: number;
  /** When the quota is refilled (`x-ratelimit-reset`). */
  readonly resetAt: Date;
}

/** Counters since the client was created. */
export interface ClientStats {
  /** Requests sent (whatever their outcome); each may cost quota. */
  readonly requests: number;
  /** Of which answered `304 Not Modified`, which do not cost quota. */
  readonly notModified: number;
}

export interface GitHubClientOptions {
  readonly token: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  readonly fetch?: typeof globalThis.fetch;
  readonly userAgent?: string;
  /** Per-request timeout (headers and body), in milliseconds. Default 15 s. */
  readonly timeoutMs?: number;
  /**
   * Bound of the ETag cache, in characters of cached response bodies; least recently used
   * entries are evicted first. Default 32 million (about 64 MB).
   */
  readonly cacheMaxChars?: number;
  /** Clock used to turn `retry-after` into a date; defaults to the system clock. */
  readonly now?: () => Date;
}

/** Query parameters; values are converted with `String()`. */
export type Query = Readonly<Record<string, string | number | boolean>>;

export interface RequestOptions {
  /** Aborts the request; its reason is rethrown as is. */
  readonly signal?: AbortSignal;
}

export interface PageOptions extends RequestOptions {
  /** Stop after this many pages (capped at {@link MAX_PAGES}). */
  readonly maxPages: number;
}

/** One page of a paginated list. */
export interface Page<T> {
  readonly data: T;
  /** Whether GitHub announced a next page (even if the page cap prevents fetching it). */
  readonly hasNext: boolean;
}

/** Turns a parsed JSON body into what the caller wants; throws `PayloadShapeError` if it cannot. */
export type Parser<T> = (body: unknown) => T;

interface ParsedResponse<T> {
  readonly data: T;
  /** The `Link` header, for pagination. */
  readonly link: string | null;
}

/**
 * Minimal read-only client for the GitHub REST API. It only ever sends GET requests: the token
 * may have write scopes, and this tool must not be able to use them.
 *
 * - Conditional requests: the ETag of each response is remembered per URL and sent back as
 *   `If-None-Match`; a `304` is served from the cache and does not cost quota.
 * - Rate limits: the `x-ratelimit-*` headers are recorded per resource ({@link rateLimit}), and
 *   rate-limited responses throw a {@link RateLimitError} saying when to retry. The client never
 *   retries by itself.
 * - Responses are validated by the caller's parser; a parser failure becomes an
 *   {@link UnexpectedPayloadError}.
 */
export class GitHubClient {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #cache: EtagCache;
  readonly #rateLimits = new Map<string, RateLimitStatus>();
  #requests = 0;
  #notModified = 0;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? 'github-action-viewer';
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#now = options.now ?? (() => new Date());
    this.#cache = new EtagCache(options.cacheMaxChars ?? 32_000_000);
  }

  /** GETs `path` (e.g. `/user`) and parses the body. */
  async get<T>(
    path: string,
    query: Query,
    parse: Parser<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.#request(apiUrl(path, query), parse, options.signal);
    return response.data;
  }

  /**
   * GETs a paginated list, following the `Link: rel="next"` header, one page at a time. The
   * caller can stop early by breaking out of the loop.
   */
  async *pages<T>(
    path: string,
    query: Query,
    parse: Parser<T>,
    options: PageOptions,
  ): AsyncGenerator<Page<T>, void, undefined> {
    const maxPages = Math.min(Math.max(1, Math.floor(options.maxPages)), MAX_PAGES);
    let url: URL | null = apiUrl(path, query);
    for (let page = 1; url !== null && page <= maxPages; page += 1) {
      const response = await this.#request(url, parse, options.signal);
      const next = nextPageUrl(describeRequest(url), response.link);
      yield { data: response.data, hasNext: next !== null };
      url = next;
    }
  }

  /** Latest known quota of a resource (`core`, `search`…); null before any response for it. */
  rateLimit(resource: string): RateLimitStatus | null {
    return this.#rateLimits.get(resource) ?? null;
  }

  get stats(): ClientStats {
    return { requests: this.#requests, notModified: this.#notModified };
  }

  async #request<T>(
    url: URL,
    parse: Parser<T>,
    signal: AbortSignal | undefined,
  ): Promise<ParsedResponse<T>> {
    const request = describeRequest(url);
    const cached = this.#cache.get(url.href);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.#token}`,
      'User-Agent': this.#userAgent,
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (cached) {
      headers['If-None-Match'] = cached.etag;
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    let text: string;
    this.#requests += 1;
    try {
      response = await this.#fetch(url, { method: 'GET', headers, signal: combined });
      this.#recordRateLimit(response.headers);
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      throw toNetworkError(request, error, timeout.aborted);
    }

    if (response.status === 304 && cached) {
      this.#notModified += 1;
      return { data: parseBody(request, 304, cached.text, parse), link: cached.link };
    }
    if (!response.ok) {
      throw this.#errorFor(request, response, text);
    }

    const data = parseBody(request, response.status, text, parse);
    // Cached only once parsed: a body the parser rejects is fetched again next time.
    const etag = response.headers.get('etag');
    const link = response.headers.get('link');
    if (etag === null) {
      this.#cache.delete(url.href);
    } else {
      this.#cache.set(url.href, { etag, text, link });
    }
    return { data, link };
  }

  #recordRateLimit(headers: Headers): void {
    const resource = headers.get('x-ratelimit-resource');
    const limit = integerHeader(headers, 'x-ratelimit-limit');
    const remaining = integerHeader(headers, 'x-ratelimit-remaining');
    const used = integerHeader(headers, 'x-ratelimit-used');
    const reset = integerHeader(headers, 'x-ratelimit-reset');
    if (resource === null || limit === null || remaining === null || reset === null) {
      return;
    }
    this.#rateLimits.set(resource, {
      resource,
      limit,
      remaining,
      used: used ?? limit - remaining,
      resetAt: new Date(reset * 1000),
    });
  }

  #errorFor(request: string, response: Response, text: string): Error {
    const { status } = response;
    const message = githubMessage(text) ?? (response.statusText || 'request failed');
    const statusText = `${String(status)} ${message}`;

    if (status === 403 || status === 429) {
      const headers = response.headers;
      const resource = headers.get('x-ratelimit-resource');
      const remaining = integerHeader(headers, 'x-ratelimit-remaining');
      const reset = integerHeader(headers, 'x-ratelimit-reset');
      const retryAfter = integerHeader(headers, 'retry-after');
      const now = this.#now().getTime();
      const afterRetryAfter = retryAfter === null ? null : now + retryAfter * 1000;

      if (remaining === 0 && reset !== null) {
        const retryAt = Math.max(reset * 1000, afterRetryAfter ?? 0);
        return new RateLimitError(request, status, 'primary', resource, new Date(retryAt));
      }
      if (afterRetryAfter !== null) {
        return new RateLimitError(
          request,
          status,
          'secondary',
          resource,
          new Date(afterRetryAfter),
        );
      }
      // No header says how long to wait: GitHub's guidance is at least one minute.
      if (status === 429 || /rate limit/i.test(message)) {
        return new RateLimitError(request, status, 'secondary', resource, new Date(now + 60_000));
      }
    }
    if (status === 401 || status === 403) {
      return new AccessDeniedError(request, status, statusText);
    }
    if (status === 404) {
      return new NotFoundError(request, status, statusText);
    }
    return new HttpError(request, status, statusText);
  }
}

function apiUrl(path: string, query: Query): URL {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError(`API path must start with a single "/": ${path}`);
  }
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** `GET /path?query`: identifies a request in messages, without the host or any header. */
function describeRequest(url: URL): string {
  return `GET ${url.pathname}${url.search}`;
}

function parseBody<T>(request: string, status: number, text: string, parse: Parser<T>): T {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new UnexpectedPayloadError(request, status, 'response is not valid JSON', {
      cause: error,
    });
  }
  try {
    return parse(body);
  } catch (error) {
    if (error instanceof PayloadShapeError) {
      throw new UnexpectedPayloadError(request, status, error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * The `rel="next"` URL of a `Link` header, e.g.
 * `<https://api.github.com/user/repos?page=2>; rel="next", <…?page=5>; rel="last"`. It must point
 * to the API itself: the token is never sent anywhere else.
 */
export function nextPageUrl(request: string, link: string | null): URL | null {
  if (link === null) {
    return null;
  }
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (match?.[2]?.split(';').some((param) => /^\s*rel="?next"?\s*$/.test(param)) === true) {
      const url = URL.parse(match[1] ?? '');
      if (url?.origin !== API_ORIGIN) {
        throw new UnexpectedPayloadError(request, null, 'next page link outside the GitHub API');
      }
      return url;
    }
  }
  return null;
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

/** The `message` of a GitHub error body, shortened; null if there is none. */
function githubMessage(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body;
      if (typeof message === 'string' && message !== '') {
        return message.length > 200 ? `${message.slice(0, 200)}…` : message;
      }
    }
  } catch {
    // Not JSON: fall back to the status text.
  }
  return null;
}

function toNetworkError(request: string, error: unknown, timedOut: boolean): NetworkError {
  if (timedOut) {
    return new NetworkError(request, 'request timed out', true, { cause: error });
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new NetworkError(request, `network error: ${detail}`, false, { cause: error });
}

interface CacheEntry {
  readonly etag: string;
  /** Response body as received, re-parsed on each hit so callers never share objects. */
  readonly text: string;
  readonly link: string | null;
}

/** URL → last response with an ETag; least recently used first out, bounded in characters. */
class EtagCache {
  readonly #maxChars: number;
  readonly #entries = new Map<string, CacheEntry>();
  #chars = 0;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry) {
      // Re-insert to mark it as most recently used.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.delete(key);
    if (entry.text.length > this.#maxChars) {
      return;
    }
    this.#entries.set(key, entry);
    this.#chars += entry.text.length;
    for (const [oldest, old] of this.#entries) {
      if (this.#chars <= this.#maxChars) {
        break;
      }
      this.#entries.delete(oldest);
      this.#chars -= old.text.length;
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
      this.#chars -= entry.text.length;
    }
  }
}
