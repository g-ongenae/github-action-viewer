import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../github/client.ts';
import {
  authorizationUrl,
  GitHubAuthorization,
  NonExpiringGitHubTokenError,
} from './github-auth.ts';
import { HostedSession } from './hosted-session.ts';
import { isValidHost, send, sendText, serveStatic, ViewerServer } from './http.ts';

const SESSION_COOKIE = '__Host-gav-session';
const STATE_COOKIE = '__Host-gav-state';
const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS_PER_USER = 4;
const MAX_EXCHANGES = 8;
const STATIC_ROOT = fileURLToPath(new URL('../../dist/web/', import.meta.url));

interface HostedOptions {
  readonly publicOrigin: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly appSlug: string;
  readonly staticRoot: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface SessionRecord {
  readonly session: HostedSession;
  readonly expiry: ReturnType<typeof setTimeout>;
  readonly userId: number;
  readonly view: string;
}

function opaqueId(): string {
  return randomBytes(32).toString('base64url');
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function cookie(name: string, value: string, lifespanMs: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(lifespanMs / 1000)}`;
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  send(response, 303, '', {
    Location: location,
    'Set-Cookie': cookies,
    'Cache-Control': 'no-store',
  });
}

function githubUserId(body: unknown): number {
  if (
    typeof body === 'object' &&
    body &&
    'id' in body &&
    typeof body.id === 'number' &&
    Number.isSafeInteger(body.id) &&
    body.id > 0
  ) {
    return body.id;
  }
  throw new Error('GitHub did not return a user ID.');
}

export function createHostedServer(options: HostedOptions): {
  server: ViewerServer;
  close: () => Promise<void>;
} {
  const fetch = options.fetch ?? globalThis.fetch;
  const app = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    callback: new URL('/auth/callback', options.publicOrigin).href,
  };
  const auth = new GitHubAuthorization(app, fetch);
  const stateKey = randomBytes(32);
  const sessions = new Map<string, SessionRecord>();
  const exchanges = new AbortController();
  let exchanging = 0;

  async function expire(id: string): Promise<void> {
    const record = sessions.get(id);
    if (record) {
      sessions.delete(id);
      clearTimeout(record.expiry);
      await record.session.close();
    }
  }

  function isIdle(session: HostedSession): boolean {
    return !session.inUse && Date.now() - session.lastActivity >= SESSION_IDLE_MS;
  }

  const sweep = setInterval(() => {
    for (const [id, { session }] of sessions) {
      if (isIdle(session)) {
        void expire(id);
      }
    }
  }, 60_000);
  sweep.unref();

  function query(request: IncomingMessage): URLSearchParams {
    const target = request.url ?? '';
    const start = target.indexOf('?');
    return new URLSearchParams(start === -1 ? '' : target.slice(start + 1));
  }

  function getSession(request: IncomingMessage): SessionRecord | null {
    const id = cookieValue(request, SESSION_COOKIE);
    const record = id && sessions.get(id);
    if (!record || !id) {
      return null;
    }
    if (record.session.expiresAt <= Date.now() || isIdle(record.session)) {
      void expire(id);
      return null;
    }
    const view = query(request).get('view');
    if (view !== null && view !== record.view) {
      return null;
    }
    record.session.touch();
    return record;
  }

  function signState(payload: string): string {
    return createHmac('sha256', stateKey).update(payload).digest('base64url');
  }

  function beginLogin(response: ServerResponse): void {
    const state = opaqueId();
    const verifier = opaqueId();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const payload = `${state}.${verifier}.${String(Date.now() + STATE_TTL_MS)}`;
    redirect(response, authorizationUrl(app, state, challenge), [
      cookie(STATE_COOKIE, `${payload}.${signState(payload)}`, STATE_TTL_MS),
    ]);
  }

  function verifierFor(request: IncomingMessage, expectedState: string | null): string | null {
    const value = cookieValue(request, STATE_COOKIE) ?? '';
    const match = /^([\w-]{43})\.([\w-]{43})\.(\d{13})\.([\w-]{43})$/.exec(value);
    if (!match) {
      return null;
    }
    const [, state, verifier, expiresAt, signature] = match;
    if (!signature || !verifier || state !== expectedState || Number(expiresAt) <= Date.now()) {
      return null;
    }
    const expectedSignature = signState(value.slice(0, -(signature.length + 1)));
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
      ? verifier
      : null;
  }

  async function completeLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const params = query(request);
    const verifier = verifierFor(request, params.get('state'));
    const code = params.get('code');
    if (!verifier) {
      sendText(
        response,
        400,
        'This sign-in link is invalid or expired. Open the viewer to try again.',
      );
      return;
    }
    const clearState = cookie(STATE_COOKIE, '', 0);
    if (!code || params.has('error')) {
      redirect(response, '/auth/sign-in', [clearState]);
      return;
    }
    if (exchanging >= MAX_EXCHANGES) {
      sendText(response, 503, 'Sign-in is busy. Try again later.', { 'Retry-After': '60' });
      return;
    }

    exchanging += 1;
    try {
      const credential = await auth.exchange(code, verifier, exchanges.signal);
      const identity = new GitHubClient({
        token: credential.accessToken,
        fetch,
        signal: exchanges.signal,
      });
      const userId = await identity.get('/user', {}, githubUserId);
      exchanges.signal.throwIfAborted();
      const previous = cookieValue(request, SESSION_COOKIE);
      const candidates = [...sessions]
        .filter(([id]) => id !== previous)
        .sort(
          ([, left], [, right]) =>
            Number(left.session.inUse) - Number(right.session.inUse) ||
            left.session.lastActivity - right.session.lastActivity,
        );
      const sameUser = candidates.filter(([, record]) => record.userId === userId);
      const evict =
        sameUser.length >= MAX_SESSIONS_PER_USER
          ? sameUser[0]
          : candidates.length >= MAX_SESSIONS
            ? candidates.find(([, record]) => !record.session.inUse)
            : undefined;
      if (candidates.length >= MAX_SESSIONS && !evict) {
        sendText(response, 503, 'All viewer sessions are busy. Try again later.', {
          'Set-Cookie': clearState,
          'Retry-After': '60',
        });
        return;
      }
      if (previous) {
        void expire(previous);
      }
      if (evict) {
        void expire(evict[0]);
      }
      const id = opaqueId();
      const session = new HostedSession(
        credential,
        Date.now() + SESSION_TTL_MS,
        auth,
        fetch,
        () => {
          void expire(id);
        },
      );
      const expiry = setTimeout(() => {
        void expire(id);
      }, SESSION_TTL_MS);
      expiry.unref();
      sessions.set(id, { session, expiry, userId, view: opaqueId() });
      redirect(response, '/dashboard', [clearState, cookie(SESSION_COOKIE, id, SESSION_TTL_MS)]);
    } catch (error) {
      if (error instanceof NonExpiringGitHubTokenError) {
        process.stderr.write(
          'GitHub returned a non-expiring user token. Enable token expiration on the GitHub App.\n',
        );
      }
      sendText(response, 502, 'GitHub sign-in failed. Open the viewer to try again.', {
        'Set-Cookie': clearState,
      });
    } finally {
      exchanging -= 1;
    }
  }

  const server = new ViewerServer({
    staticRoot: options.staticRoot,
    log: () => {
      process.stderr.write('Hosted viewer request failed.\n');
    },
    maxEventClients: MAX_SESSIONS * 4,
    sessions: {
      publicOrigin: options.publicOrigin,
      maxStreamsPerContext: 4,
      resolve: (request) => getSession(request)?.session.context() ?? null,
      handlePage: async (path, request, response) => {
        if (path === '/auth/logout') {
          if (request.method !== 'POST') {
            sendText(response, 405, 'Method Not Allowed', { Allow: 'POST' });
          } else if (request.headers.origin !== options.publicOrigin.origin) {
            sendText(response, 403, 'Forbidden');
          } else {
            request.resume();
            if (query(request).has('view') && !getSession(request)) {
              sendText(response, 401, 'Sign in with GitHub');
              return true;
            }
            const id = cookieValue(request, SESSION_COOKIE);
            if (id) {
              await expire(id);
            }
            send(response, 204, '', {
              'Set-Cookie': [cookie(SESSION_COOKIE, '', 0), cookie(STATE_COOKIE, '', 0)],
              'Cache-Control': 'no-store',
            });
          }
          return true;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return false;
        }
        if (path === '/' || path === '/index.html') {
          redirect(response, getSession(request) ? '/dashboard' : '/auth/sign-in');
        } else if (path === '/dashboard') {
          if (getSession(request)) {
            await serveStatic(options.staticRoot, '/', response, { cacheControl: 'no-store' });
          } else {
            redirect(response, '/auth/sign-in');
          }
        } else if (path === '/auth/sign-in') {
          await serveStatic(options.staticRoot, '/sign-in.html', response, {
            cacheControl: 'no-store',
          });
        } else if (path === '/auth/session') {
          const record = getSession(request);
          if (!record) {
            sendText(response, 401, 'Sign in with GitHub');
          } else {
            send(
              response,
              200,
              JSON.stringify({
                view: record.view,
                installationUrl: `https://github.com/apps/${options.appSlug}/installations/new`,
              }),
              { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            );
          }
        } else if (path === '/auth/login' && request.method === 'GET') {
          const site = request.headers['sec-fetch-site'];
          if (site === undefined || site === 'none' || site === 'same-origin') {
            beginLogin(response);
          } else {
            redirect(response, '/auth/sign-in');
          }
        } else if (path === '/auth/callback' && request.method === 'GET') {
          await completeLogin(request, response);
        } else {
          return false;
        }
        return true;
      },
    },
  });

  return {
    server,
    close: async () => {
      exchanges.abort();
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(expire));
      await server.close();
    },
  };
}

async function main(): Promise<void> {
  const { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG, VIEWER_PUBLIC_ORIGIN } =
    process.env;
  if (
    !GITHUB_APP_CLIENT_ID ||
    !GITHUB_APP_CLIENT_SECRET ||
    !GITHUB_APP_SLUG ||
    !/^[a-z0-9-]+$/.test(GITHUB_APP_SLUG) ||
    !VIEWER_PUBLIC_ORIGIN
  ) {
    throw new Error(
      'Set GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG and VIEWER_PUBLIC_ORIGIN.',
    );
  }
  const publicOrigin = URL.parse(VIEWER_PUBLIC_ORIGIN);
  if (
    publicOrigin?.protocol !== 'https:' ||
    !isValidHost(publicOrigin.host) ||
    VIEWER_PUBLIC_ORIGIN.replace(/\/$/, '') !== publicOrigin.origin
  ) {
    throw new Error('VIEWER_PUBLIC_ORIGIN must be a canonical HTTPS origin without a path.');
  }
  const port = Number(process.env.PORT ?? '4680');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const hosted = createHostedServer({
    publicOrigin,
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
    appSlug: GITHUB_APP_SLUG,
    staticRoot: STATIC_ROOT,
  });
  await hosted.server.listen(port);
  process.stdout.write(`Serving ${publicOrigin.origin} via http://127.0.0.1:${String(port)}/\n`);
  const stop = (): void => {
    setTimeout(() => process.exit(1), 5000).unref();
    void hosted.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Hosted viewer failed to start.'}\n`,
    );
    process.exitCode = 1;
  });
}
