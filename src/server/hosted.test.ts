import { createHash } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawRepository, rawRun } from '../github/test-fixtures.ts';
import { createHostedServer } from './hosted.ts';

const origin = new URL('https://viewer.example');
const tokensUsed: string[] = [];
const exchanges: URLSearchParams[] = [];
let denyAlice = false;
let nextCode = 0;
const redeemedCodes = new Set<string>();
let hosted: ReturnType<typeof createHostedServer>;
let port: number;

beforeEach(async () => {
  tokensUsed.length = 0;
  exchanges.length = 0;
  denyAlice = false;
  nextCode = 0;
  redeemedCodes.clear();
  hosted = createHostedServer({
    publicOrigin: origin,
    staticRoot: fileURLToPath(new URL('../web/', import.meta.url)),
    clientId: 'client-id',
    clientSecret: 'mock-secret',
    appSlug: 'actions-viewer',
    fetch: async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname === 'github.com') {
        const body = new URLSearchParams(await req.text());
        exchanges.push(body);
        const refresh = body.get('refresh_token');
        const code = body.get('code');
        if (code) {
          if (redeemedCodes.has(code)) {
            return Response.json({ error: 'bad_verification_code' });
          }
          redeemedCodes.add(code);
        }
        const name = refresh ? refresh.split('-')[1] : code?.split('-')[0];
        return Response.json({
          access_token: refresh ? `rotated-${name ?? ''}` : `access-${name ?? ''}`,
          refresh_token: `refresh-${name ?? ''}`,
          expires_in: !refresh && name === 'alice' ? 10 : 28800,
        });
      }
      const token = req.headers.get('authorization') ?? '';
      tokensUsed.push(token);
      const alice = token.endsWith('-alice');
      const login = alice ? 'alice' : 'bob';
      const repo = rawRepository(`${login}/private`, { pushed_at: new Date().toISOString() });
      if (url.pathname === '/user') {
        return Response.json({ id: alice ? 1 : 2, login });
      }
      if (url.pathname === '/search/issues') {
        return Response.json({ items: [], incomplete_results: false });
      }
      if (url.pathname === '/user/repos') {
        return Response.json([repo]);
      }
      if (url.pathname === `/repos/${login}/private`) {
        return Response.json(repo);
      }
      if (url.pathname.endsWith('/actions/runs')) {
        if (alice && denyAlice) {
          return Response.json({ message: 'Not Found' }, { status: 404 });
        }
        return Response.json({ workflow_runs: [rawRun(repo)] });
      }
      return Response.json([]);
    },
  });
  port = await hosted.server.listen(0);
});

afterEach(async () => {
  await hosted.close();
});

function open(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: origin.host, ...headers },
        method,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

async function read(path: string, headers?: Record<string, string>, method?: string) {
  const response = await open(path, headers, method);
  const body = await new Promise<string>((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk;
    });
    response.on('end', () => {
      resolve(text);
    });
    response.on('error', reject);
  });
  return { status: response.statusCode, headers: response.headers, body };
}

function cookie(header: string | undefined): string {
  if (!header) {
    throw new Error('Expected a cookie');
  }
  return header.split(';')[0] ?? '';
}

async function login(user: string, existing?: { cookie: string }) {
  const start = await read('/auth/login', existing);
  expect(start.status).toBe(303);
  const authorization = new URL(start.headers.location ?? '');
  const state = authorization.searchParams.get('state') ?? '';
  const code = `${user}-${String(nextCode++)}`;
  const path = `/auth/callback?state=${state}&code=${code}`;
  const pendingCookie = cookie(start.headers['set-cookie']?.[0]);
  expect((await read(path)).status).toBe(400);
  const replacement = pendingCookie.endsWith('a') ? 'b' : 'a';
  const tamperedCookie = pendingCookie.slice(0, -1) + replacement;
  expect((await read(path, { cookie: tamperedCookie })).status).toBe(400);
  const result = await read(path, {
    cookie: existing ? `${pendingCookie}; ${existing.cookie}` : pendingCookie,
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  });
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe('/dashboard');
  // GitHub rejects the already-redeemed code even if the old cookie is replayed.
  expect((await read(path, { cookie: pendingCookie })).status).toBe(502);
  const tokenExchange = exchanges.find((exchange) => exchange.get('code') === code);
  const challenge = createHash('sha256')
    .update(tokenExchange?.get('code_verifier') ?? '')
    .digest('base64url');
  expect(challenge).toBe(authorization.searchParams.get('code_challenge'));
  expect(result.headers['set-cookie']?.[1]).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(result.headers['set-cookie']?.[1]).not.toContain(`access-${user}`);
  return { cookie: cookie(result.headers['set-cookie']?.[1]) };
}

describe('hosted viewer', () => {
  it('exchanges the GitHub code and scopes requests and live data to the browser session', async () => {
    expect((await read('/')).headers.location).toBe('/auth/sign-in');
    expect((await read('/%69ndex.html')).status).toBe(404);
    expect((await read('/api/snapshot')).status).toBe(401);
    expect((await read('/api/events')).status).toBe(401);
    expect((await read('/api/repositories')).status).toBe(401);
    const alice = await login('alice');
    const bob = await login('bob');
    expect((await read('/%69ndex.html', alice)).status).toBe(404);
    const aliceView = await read('/auth/session', alice);
    expect(aliceView.body).toContain('https://github.com/apps/actions-viewer/installations/new');
    const view = (JSON.parse(aliceView.body) as { view: string }).view;
    expect((await read(`/api/snapshot?view=${view}`, bob)).status).toBe(401);
    expect((await read('/dashboard', alice)).headers['cache-control']).toBe('no-store');
    const aliceStream = await open('/api/events', alice);
    const bobStream = await open('/api/events', bob);
    const aliceChunks: string[] = [];
    const bobChunks: string[] = [];
    aliceStream.setEncoding('utf8').on('data', (chunk: string) => {
      aliceChunks.push(chunk);
    });
    bobStream.setEncoding('utf8').on('data', (chunk: string) => {
      bobChunks.push(chunk);
    });
    await vi.waitFor(() => {
      expect(aliceChunks.join('')).toContain('alice/private');
      expect(bobChunks.join('')).toContain('bob/private');
    });
    expect(aliceChunks.join('')).not.toContain('bob/private');
    expect(bobChunks.join('')).not.toContain('alice/private');
    expect(exchanges.filter((exchange) => exchange.has('refresh_token'))).toHaveLength(1);
    expect(tokensUsed).toContain('Bearer rotated-alice');

    const aliceOrigin = { ...alice, Origin: origin.origin };
    denyAlice = true;
    expect(
      (await read('/api/maintained-repositories/alice/private', aliceOrigin, 'PUT')).status,
    ).toBe(200);
    await vi.waitFor(async () => {
      const payload = await read('/api/snapshot', alice);
      expect(payload.body).toContain('"httpStatus":404');
      expect(payload.body).not.toContain('"fullName":"alice/private"');
    });
    expect((await read('/api/snapshot', bob)).body).toContain('"maintainedRepositories":[]');
    expect((await read('/auth/logout', alice, 'POST')).status).toBe(403);
    expect((await read('/auth/logout', aliceOrigin, 'POST')).status).toBe(204);
    await vi.waitFor(() => {
      expect(aliceStream.complete).toBe(true);
      expect(aliceChunks.join('')).toContain('event: auth');
    });
    expect((await read('/api/snapshot', alice)).status).toBe(401);
    expect(bobStream.complete).toBe(false);
  });
  it('replaces the prior session when the same browser switches accounts', async () => {
    const alice = await login('alice');
    const aliceView = (JSON.parse((await read('/auth/session', alice)).body) as { view: string })
      .view;
    const bob = await login('bob', alice);
    expect((await read('/auth/session', alice)).status).toBe(401);
    expect((await read('/auth/session', bob)).status).toBe(200);
    const stalePage = `view=${aliceView}`;
    expect((await read(`/api/repositories?${stalePage}`, bob)).status).toBe(401);
    const bobOrigin = { ...bob, Origin: origin.origin };
    expect((await read(`/auth/logout?${stalePage}`, bobOrigin, 'POST')).status).toBe(401);
    expect((await read('/auth/session', bob)).status).toBe(200);
  });
  it('keeps accepting sign-in starts when prior attempts were abandoned', async () => {
    for (let attempt = 0; attempt < 129; attempt += 1) {
      expect((await read('/auth/login')).status).toBe(303);
    }
    const alice = await login('alice');
    expect((await read('/auth/session', alice)).status).toBe(200);
  });

  it('replaces the least recently used session when an account opens a fifth session', async () => {
    const oldest = await login('alice');
    const second = await login('alice');
    await login('alice');
    await login('alice');
    const newest = await login('alice');
    expect((await read('/auth/session', oldest)).status).toBe(401);
    expect((await read('/auth/session', second)).status).toBe(200);
    expect((await read('/auth/session', newest)).status).toBe(200);
  });
  it('expires a session after 30 minutes without a request or open stream', async () => {
    const alice = await login('alice');
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    try {
      expect((await read('/auth/session', alice)).status).toBe(401);
    } finally {
      time.mockRestore();
    }
    expect((await read('/auth/session', alice)).status).toBe(401);
  });
});
