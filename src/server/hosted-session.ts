import { DEFAULT_CONFIG, type Config } from '../core/config.ts';
import { GitHubClient } from '../github/client.ts';
import { collectSnapshot } from '../github/collect.ts';
import type { ConfigUpdate } from './config-file.ts';
import {
  GitHubAuthorizationError,
  type GitHubAuthorization,
  type UserCredential,
} from './github-auth.ts';
import type { ViewerContext } from './http.ts';
import type { ConfigStatus } from './payload.ts';
import { Poller, type PollState } from './poller.ts';
import { PayloadStore } from './store.ts';
import { ConfigWatchListEditor } from './watch-list-editor.ts';

const IDLE_MS = 2 * 60_000;
const SNAPSHOT_TTL_MS = 2 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_RETRY_MS = 30_000;
const MAX_WATCHED_REPOSITORIES = 50;

export class HostedSession {
  readonly #lifetime = new AbortController();
  readonly #authorization: GitHubAuthorization;
  readonly #fetch: typeof globalThis.fetch;
  readonly #invalidate: () => void;
  readonly expiresAt: number;
  #credential: UserCredential;
  #refresh: Promise<string> | null = null;
  #refreshRetryAt = 0;
  #activities = 0;
  #lastActivity = Date.now();
  #runtime: { context: ViewerContext; close: () => Promise<void> } | null = null;
  #config: Config = { ...DEFAULT_CONFIG, pollIntervalSeconds: 30 };

  constructor(
    credential: UserCredential,
    expiresAt: number,
    authorization: GitHubAuthorization,
    fetch: typeof globalThis.fetch,
    invalidate: () => void,
  ) {
    this.#credential = credential;
    this.expiresAt = expiresAt;
    this.#authorization = authorization;
    this.#fetch = fetch;
    this.#invalidate = invalidate;
  }

  get inUse(): boolean {
    return this.#activities > 0;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  touch(): void {
    this.#lastActivity = Date.now();
  }

  context(): ViewerContext {
    this.#runtime ??= this.#startRuntime();
    return this.#runtime.context;
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    await this.#runtime?.close();
    this.#runtime = null;
  }

  #getToken(): Promise<string> {
    this.#lifetime.signal.throwIfAborted();
    if (Date.now() + REFRESH_MARGIN_MS < this.#credential.expiresAt) {
      return Promise.resolve(this.#credential.accessToken);
    }
    if (Date.now() < this.#refreshRetryAt) {
      if (Date.now() < this.#credential.expiresAt) {
        return Promise.resolve(this.#credential.accessToken);
      }
      throw new Error('GitHub authorization is temporarily unavailable.');
    }
    this.#refresh ??= this.#rotate().finally(() => {
      this.#refresh = null;
    });
    return this.#refresh;
  }

  async #rotate(): Promise<string> {
    try {
      const credential = await this.#authorization.refresh(this.#credential, this.#lifetime.signal);
      this.#lifetime.signal.throwIfAborted();
      this.#credential = credential;
      return credential.accessToken;
    } catch (error) {
      if (error instanceof GitHubAuthorizationError) {
        this.#invalidate();
      } else {
        this.#refreshRetryAt = Date.now() + REFRESH_RETRY_MS;
      }
      throw error;
    }
  }

  #configStatus(): ConfigStatus {
    return {
      state: 'ok',
      problems: null,
      fallback: null,
      editing: 'on',
      maintainedRepositories: this.#config.maintainedRepositories,
    };
  }

  #startRuntime(): { context: ViewerContext; close: () => Promise<void> } {
    const lifetime = new AbortController();
    const client = new GitHubClient({
      token: this.#credential.accessToken,
      getToken: () => this.#getToken(),
      onUnauthorized: (token) => {
        if (token === this.#credential.accessToken && this.#refresh === null) {
          this.#invalidate();
        }
      },
      signal: lifetime.signal,
      fetch: this.#fetch,
      cacheMaxChars: 0,
    });

    let expiry: ReturnType<typeof setTimeout> | undefined;
    const publish = (state: PollState): void => {
      clearTimeout(expiry);
      const age = state.snapshot
        ? Date.now() - Date.parse(state.snapshot.generatedAt)
        : SNAPSHOT_TTL_MS;
      if (age >= SNAPSHOT_TTL_MS) {
        store.setPollState({ ...state, snapshot: null });
        return;
      }
      store.setPollState(state);
      expiry = setTimeout(() => {
        store.setPollState({ ...poller.state, snapshot: null });
      }, SNAPSHOT_TTL_MS - age);
      expiry.unref();
    };
    const poller = new Poller({
      config: () => this.#config,
      collect: (config, signal) =>
        collectSnapshot(client, config, { now: new Date(), signal, concurrency: 2 }),
      onUpdate: publish,
      keepPreviousSnapshot: false,
    });
    const store = new PayloadStore(poller.state, this.#configStatus());

    const watchList = new ConfigWatchListEditor({
      client,
      configFile: {
        update: (edit): Promise<ConfigUpdate> => {
          lifetime.signal.throwIfAborted();
          const patch = edit(this.#config);
          if (patch === null) {
            return Promise.resolve({ kind: 'unchanged', config: this.#config });
          }
          const config = { ...this.#config, ...patch };
          if (config.maintainedRepositories.length > MAX_WATCHED_REPOSITORIES) {
            return Promise.resolve({
              kind: 'refused',
              reason: 'invalid',
              message: `You can add up to ${String(MAX_WATCHED_REPOSITORIES)} repositories.`,
            });
          }
          this.#config = config;
          store.setConfigStatus(this.#configStatus());
          poller.pollNow();
          return Promise.resolve({ kind: 'saved', config });
        },
      },
      rateLimitedUntil: () => {
        const retryAt = poller.state.status.rateLimits.retryAt;
        return retryAt ? Date.parse(retryAt) : null;
      },
      onRateLimit: (retryAt) => {
        poller.holdUntil(retryAt);
      },
    });

    let idle: ReturnType<typeof setTimeout> | undefined;
    const close = async (): Promise<void> => {
      lifetime.abort();
      clearTimeout(idle);
      clearTimeout(expiry);
      await poller.stop();
    };
    const scheduleIdle = (): void => {
      idle = setTimeout(() => {
        this.#runtime = null;
        void close();
      }, IDLE_MS);
      idle.unref();
    };
    scheduleIdle();

    const beginActivity = (): (() => void) => {
      this.#activities += 1;
      this.touch();
      clearTimeout(idle);
      return () => {
        this.#activities -= 1;
        this.touch();
        if (!this.inUse && !lifetime.signal.aborted) {
          scheduleIdle();
        }
      };
    };
    const withActivity = async <T>(operation: () => Promise<T>): Promise<T> => {
      const end = beginActivity();
      try {
        return await operation();
      } finally {
        end();
      }
    };

    return {
      context: {
        source: store,
        watchList: {
          catalogue: () => withActivity(() => watchList.catalogue()),
          add: (repository) => withActivity(() => watchList.add(repository)),
          remove: (repository) => withActivity(() => watchList.remove(repository)),
        },
        signal: lifetime.signal,
        onStreamOpen: () => {
          const end = beginActivity();
          poller.start();
          return end;
        },
      },
      close,
    };
  }
}
