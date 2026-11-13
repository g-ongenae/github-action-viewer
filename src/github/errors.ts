// Typed errors of the GitHub client. Messages name the request (`GET /repos/…`) but never carry
// the token or any request header.

/** Base class: something went wrong while talking to GitHub. */
export class GitHubError extends Error {
  /** The request, e.g. `GET /repos/octo-org/widgets/actions/runs?per_page=100`. */
  readonly request: string;
  /** HTTP status of the response; null when there was no response (network error, timeout). */
  readonly status: number | null;

  constructor(request: string, status: number | null, message: string, options?: ErrorOptions) {
    super(`${request}: ${message}`, options);
    this.name = new.target.name;
    this.request = request;
    this.status = status;
  }
}

/** 404: the resource does not exist, or the token cannot see it (GitHub does not tell which). */
export class NotFoundError extends GitHubError {}

/** 401 (bad or expired token) or a 403 that is not a rate limit (missing permission or scope). */
export class AccessDeniedError extends GitHubError {}

/** Any other unexpected status, e.g. a 5xx or a 422. */
export class HttpError extends GitHubError {}

/**
 * No response: DNS, connection or TLS failure, or the request timed out. It carries neither the
 * text nor the cause of the underlying error, which can quote request headers (the token).
 */
export class NetworkError extends GitHubError {
  readonly timedOut: boolean;
  /** System or undici error code, e.g. `ECONNRESET`, when there was one. */
  readonly code: string | null;

  constructor(request: string, timedOut: boolean, code: string | null) {
    super(
      request,
      null,
      timedOut ? 'request timed out' : `network error${code === null ? '' : ` (${code})`}`,
    );
    this.timedOut = timedOut;
    this.code = code;
  }
}

/** The token cannot be a GitHub token. The message never quotes it. */
export class MalformedTokenError extends Error {
  constructor(source = 'The GitHub token') {
    super(
      `${source} is malformed: it must be non-empty printable ASCII, without spaces or line breaks.`,
    );
    this.name = 'MalformedTokenError';
  }
}

/** The response was not what the client expects: invalid JSON, or a field it reads is missing. */
export class UnexpectedPayloadError extends GitHubError {}

/** Which rate limit was hit. */
export type RateLimitKind =
  /** The hourly quota of a resource (`x-ratelimit-remaining: 0`). */
  | 'primary'
  /** An abuse-prevention limit (too many requests too fast, or too many at once). */
  | 'secondary';

/**
 * 403 or 429 because of a rate limit. The client never retries by itself: whoever paces the
 * requests must wait until {@link retryAt}.
 */
export class RateLimitError extends GitHubError {
  readonly kind: RateLimitKind;
  /** `x-ratelimit-resource`, e.g. `core` or `search`; null if GitHub did not say. */
  readonly resource: string | null;
  /** Earliest time at which retrying is allowed. */
  readonly retryAt: Date;

  constructor(
    request: string,
    status: number,
    kind: RateLimitKind,
    resource: string | null,
    retryAt: Date,
  ) {
    super(
      request,
      status,
      `${kind} rate limit exceeded${resource === null ? '' : ` (${resource})`}, retry after ${retryAt.toISOString()}`,
    );
    this.kind = kind;
    this.resource = resource;
    this.retryAt = retryAt;
  }
}
