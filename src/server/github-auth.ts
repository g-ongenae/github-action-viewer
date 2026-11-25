import { isWellFormedToken } from '../github/client.ts';

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';

export interface GitHubApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callback: string;
}

export interface UserCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export class GitHubAuthorizationError extends Error {
  constructor() {
    super('GitHub authorization expired or was rejected.');
  }
}

export function authorizationUrl(app: GitHubApp, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.callback,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

export class GitHubAuthorization {
  readonly #app: GitHubApp;
  readonly #fetch: typeof globalThis.fetch;

  constructor(app: GitHubApp, fetch: typeof globalThis.fetch) {
    this.#app = app;
    this.#fetch = fetch;
  }

  exchange(code: string, verifier: string, signal: AbortSignal): Promise<UserCredential> {
    return this.#token(
      {
        code,
        code_verifier: verifier,
        redirect_uri: this.#app.callback,
      },
      signal,
    );
  }

  refresh(credential: UserCredential, signal: AbortSignal): Promise<UserCredential> {
    return this.#token(
      {
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      },
      signal,
    );
  }

  async #token(parameters: Record<string, string>, signal: AbortSignal): Promise<UserCredential> {
    const response = await this.#fetch(TOKEN, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.#app.clientId,
        client_secret: this.#app.clientSecret,
        ...parameters,
      }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status >= 500 || response.status === 429) {
      throw new Error('GitHub authorization is temporarily unavailable.');
    }
    if (!response.ok) {
      throw new GitHubAuthorizationError();
    }
    const value: unknown = await response.json();
    if (typeof value !== 'object' || !value) {
      throw new GitHubAuthorizationError();
    }
    const accessToken = 'access_token' in value ? value.access_token : null;
    const refreshToken = 'refresh_token' in value ? value.refresh_token : null;
    const expiresIn = 'expires_in' in value ? value.expires_in : null;
    if (
      typeof accessToken !== 'string' ||
      !isWellFormedToken(accessToken) ||
      typeof refreshToken !== 'string' ||
      !isWellFormedToken(refreshToken) ||
      typeof expiresIn !== 'number' ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new GitHubAuthorizationError();
    }
    return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
  }
}
