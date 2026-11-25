import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, isValidHost, ViewerServer } from './http.ts';
import type { Heartbeat, RepositoryCatalogue, WatchListChange } from './payload.ts';
import type { PayloadSource } from './store.ts';
import { WatchListError, type WatchListEditor } from './watch-list-editor.ts';

/** A payload source the test drives by hand. */
class FakeSource implements PayloadSource {
  json = '{"version":1}';
  readonly listeners = new Set<(changed: boolean) => void>();

  payloadJson(): string {
    return this.json;
  }

  heartbeat(): Heartbeat {
    return {
      serverTime: '2026-11-13T12:00:00.000Z',
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextPollAt: null,
      pollInterval: { baseSeconds: 15, currentSeconds: 15, reason: 'base' },
      rateLimits: { core: null, search: null, retryAt: null },
    };
  }

  subscribe(listener: (changed: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(changed: boolean): void {
    for (const listener of this.listeners) {
      listener(changed);
    }
  }
}

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let root: string;
let source: FakeSource;
let server: ViewerServer;
let port: number;
let logs: string[];

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gav-http-'));
  root = join(dir, 'web');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>t</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'export {};');
  await writeFile(join(root, 'assets', 'style.css'), 'body {}');
  await writeFile(join(root, '.hidden'), 'secret');
  await writeFile(join(dir, 'outside.txt'), 'secret');
  await symlink(join(dir, 'outside.txt'), join(root, 'link.txt'));
  source = new FakeSource();
  logs = [];
  server = new ViewerServer({
    source,
    staticRoot: root,
    log: (line) => logs.push(line),
    heartbeatMs: 50,
    maxEventClients: 2,
  });
  port = await server.listen(0);
});

afterEach(async () => {
  await server.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

function host(): string {
  return `127.0.0.1:${String(port)}`;
}

/** Sends a raw request (fetch would not let the test set `Host`). */
function send(
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: host(), ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Opens the event stream; collects the events as they arrive. */
async function openStream(headers: Record<string, string> = {}): Promise<{
  res: IncomingMessage;
  events: { event: string; data: string }[];
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: string }[] = [];
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/events', headers: { host: host(), ...headers } },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event !== undefined && data !== undefined) {
              events.push({ event, data });
            }
          }
        });
        resolve({ res, events, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function expectSecurityHeaders(headers: IncomingHttpHeaders): void {
  expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
}

describe('ViewerServer', () => {
  it('serves the payload', async () => {
    const response = await send('/api/snapshot?x=1');
    expect(response).toMatchObject({ status: 200, body: '{"version":1}' });
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(response.headers);
  });

  it.each([
    ['/', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
    ['/assets/app.js', 'text/javascript; charset=utf-8', 'export {};'],
    ['/assets/style.css', 'text/css; charset=utf-8', 'body {}'],
    ['/assets/%61pp.js', 'text/javascript; charset=utf-8', 'export {};'],
  ])('serves the static file %s', async (path, type, body) => {
    const response = await send(path);
    expect(response).toMatchObject({ status: 200, body });
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['cache-control']).toBe('no-cache');
    expectSecurityHeaders(response.headers);
  });

  it('answers HEAD without a body', async () => {
    const response = await send('/assets/app.js', { method: 'HEAD' });
    expect(response).toMatchObject({ status: 200, body: '' });
    expect(response.headers['content-length']).toBe('10');
  });

  it.each([
    '/missing.html',
    '/assets',
    '/assets/',
    '/api/other',
    '/.hidden',
    '/%2ehidden',
    '/../outside.txt',
    '/assets/../../outside.txt',
    '/%2e%2e/outside.txt',
    '/assets%2f..%2f..%2foutside.txt',
    '/..%5coutside.txt',
    '/index.html%00',
    '/%E0%A4%A',
    '/link.txt',
  ])('answers 404 to %s', async (path) => {
    const response = await send(path);
    expect(response).toMatchObject({ status: 404, body: 'Not Found\n' });
    expect(response.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(response.headers);
  });

  it('refuses a path that is not absolute', async () => {
    expect((await send('*', { method: 'GET' })).status).toBe(400);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('answers 405 to %s', async (method) => {
    const response = await send('/api/snapshot', { method });
    expect(response).toMatchObject({ status: 405, body: 'Method Not Allowed\n' });
    expect(response.headers.allow).toBe('GET, HEAD');
  });

  it('accepts localhost as a host name', async () => {
    expect(
      (await send('/api/snapshot', { headers: { host: `LocalHost:${String(port)}` } })).status,
    ).toBe(200);
  });

  it.each([
    ['another name (DNS rebinding)', 'attacker.example:PORT'],
    ['another port', '127.0.0.1:1'],
    ['no port', '127.0.0.1'],
    ['an IPv6 loopback', '[::1]:PORT'],
  ])('refuses %s in Host', async (_name, value) => {
    const response = await send('/api/snapshot', {
      headers: { host: value.replace('PORT', String(port)) },
    });
    expect(response).toMatchObject({ status: 403, body: 'Forbidden\n' });
    expect(response.body).not.toContain('version');
  });

  it.each([
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'sec-fetch-site': 'same-site' }, 403],
    [{ 'sec-fetch-site': 'same-origin' }, 200],
    [{ 'sec-fetch-site': 'none' }, 200],
    [{ origin: 'https://attacker.example' }, 403],
    [{ origin: 'null' }, 403],
    [{ origin: 'http://localhost:1' }, 403],
    [{ origin: 'http://127.0.0.1:PORT' }, 200],
  ])('checks the request site: %o → %s', async (headers, status) => {
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, value.replace('PORT', String(port))]),
    );
    expect((await send('/api/snapshot', { headers: resolved })).status).toBe(status);
    expect((await send('/api/events', { method: 'HEAD', headers: resolved })).status).toBe(status);
  });

  it.each(['cross-site', 'same-site'])(
    'serves the page to a %s navigation (a link from another site)',
    async (site) => {
      const navigation = {
        'sec-fetch-site': site,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      };
      expect((await send('/', { headers: navigation })).status).toBe(200);
      // Only the page: API reads and sub-resources from another site are still refused.
      expect((await send('/api/snapshot', { headers: navigation })).status).toBe(403);
      expect(
        (await send('/', { headers: { ...navigation, 'sec-fetch-dest': 'iframe' } })).status,
      ).toBe(403);
      expect(
        (await send('/', { headers: { ...navigation, origin: 'https://attacker.example' } }))
          .status,
      ).toBe(403);
      expect((await send('/', { headers: { 'sec-fetch-site': site } })).status).toBe(403);
    },
  );

  it('answers to allowed hosts and their origins, and to them only', async () => {
    const proxied = new ViewerServer({
      source,
      staticRoot: root,
      log: () => undefined,
      allowedHosts: ['Box.tailnet.ts.net:4680'],
    });
    const proxiedPort = await proxied.listen(0);
    const get = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        httpRequest(
          { host: '127.0.0.1', port: proxiedPort, path: '/api/snapshot', headers },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
          .on('error', reject)
          .end();
      });
    try {
      const tailnet = 'box.tailnet.ts.net:4680';
      expect(await get({ host: tailnet })).toBe(200);
      expect(await get({ host: tailnet, origin: `https://${tailnet}` })).toBe(200);
      expect(await get({ host: `127.0.0.1:${String(proxiedPort)}` })).toBe(200);
      expect(await get({ host: 'box.tailnet.ts.net' })).toBe(403);
      expect(await get({ host: 'other.tailnet.ts.net:4680' })).toBe(403);
      expect(await get({ host: tailnet, origin: 'https://other.tailnet.ts.net:4680' })).toBe(403);
      expect(await get({ host: tailnet, 'sec-fetch-site': 'same-site' })).toBe(403);
    } finally {
      await proxied.close();
    }
  });

  it.each([
    ['box.tailnet.ts.net', true],
    ['box.tailnet.ts.net:4680', true],
    ['127.0.0.1:8080', true],
    ['', false],
    ['http://box.tailnet.ts.net', false],
    ['box.tailnet.ts.net/path', false],
    ['box..ts.net', false],
    ['box.ts.net:', false],
  ])('isValidHost(%j) is %s', (value, valid) => {
    expect(isValidHost(value)).toBe(valid);
  });

  it('streams the payload, changes and heartbeats, and forgets disconnected clients', async () => {
    const stream = await openStream();
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.res.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(stream.res.headers);
    await vi.waitFor(() => {
      expect(stream.events[0]).toEqual({ event: 'payload', data: '{"version":1}' });
    });

    source.json = '{"version":2}';
    source.emit(true);
    await vi.waitFor(() => {
      expect(stream.events).toContainEqual({ event: 'payload', data: '{"version":2}' });
    });
    source.emit(false);
    await vi.waitFor(() => {
      expect(stream.events.filter((e) => e.event === 'heartbeat').length).toBeGreaterThan(1);
    });
    const heartbeat = stream.events.find((e) => e.event === 'heartbeat');
    expect(JSON.parse(heartbeat?.data ?? '')).toEqual(source.heartbeat());

    // The client limit (2 here) counts open streams only.
    const second = await openStream();
    expect((await send('/api/events')).status).toBe(503);
    stream.close();
    second.close();
    await vi.waitFor(async () => {
      const third = await openStream();
      third.close();
      expect(third.res.statusCode).toBe(200);
    });
  });

  it('ends the streams on close', async () => {
    const stream = await openStream();
    const ended = new Promise((resolve) => stream.res.on('close', resolve));
    await server.close();
    await ended;
    server = new ViewerServer({ source, staticRoot: root, log: () => undefined });
    await server.listen(0);
  });

  it('fails to listen on a port in use', async () => {
    const other = new ViewerServer({ source, staticRoot: root, log: () => undefined });
    await expect(other.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

/** An editor that records what it was asked, and answers or fails as the test says. */
class FakeEditor implements WatchListEditor {
  readonly calls: string[] = [];
  failure: Error | null = null;

  catalogue(): Promise<RepositoryCatalogue> {
    this.calls.push('catalogue');
    return this.#answer({ repositories: [{ fullName: 'o/r', private: true }], complete: true });
  }

  add(repository: string): Promise<WatchListChange> {
    this.calls.push(`add ${repository}`);
    return this.#answer({ repository, changed: true, maintainedRepositories: [repository] });
  }

  remove(repository: string): Promise<WatchListChange> {
    this.calls.push(`remove ${repository}`);
    return this.#answer({ repository, changed: true, maintainedRepositories: [] });
  }

  #answer<T>(value: T): Promise<T> {
    return this.failure === null ? Promise.resolve(value) : Promise.reject(this.failure);
  }
}

describe('ViewerServer: editing the watch list', () => {
  let editor: FakeEditor;
  const origin = (): Record<string, string> => ({ origin: `http://${host()}` });

  beforeEach(async () => {
    await server.close();
    editor = new FakeEditor();
    server = new ViewerServer({
      source,
      staticRoot: root,
      log: (line) => logs.push(line),
      watchList: editor,
      allowedHosts: ['viewer.example.ts.net'],
    });
    port = await server.listen(0);
  });

  it('has no such routes without an editor', async () => {
    await server.close();
    server = new ViewerServer({ source, staticRoot: root, log: () => undefined });
    port = await server.listen(0);

    expect(await send('/api/repositories')).toMatchObject({ status: 404, body: 'Not Found\n' });
    const response = await send('/api/maintained-repositories/o/r', {
      method: 'PUT',
      headers: origin(),
    });
    expect(response).toMatchObject({ status: 405, body: 'Method Not Allowed\n' });
    expect(response.headers.allow).toBe('GET, HEAD');
  });

  it('serves the repositories offered to add', async () => {
    const response = await send('/api/repositories');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      repositories: [{ fullName: 'o/r', private: true }],
      complete: true,
    });
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(response.headers);
  });

  it('adds a repository on PUT and removes it on DELETE, taking the name from the path', async () => {
    const added = await send('/api/maintained-repositories/Octo-Org/my.widgets_2?x=1', {
      method: 'PUT',
      headers: origin(),
    });
    expect(added.status).toBe(200);
    expect(JSON.parse(added.body)).toEqual({
      repository: 'Octo-Org/my.widgets_2',
      changed: true,
      maintainedRepositories: ['Octo-Org/my.widgets_2'],
    });
    expect(added.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(added.headers);

    const removed = await send('/api/maintained-repositories/Octo-Org/my.widgets_2', {
      method: 'DELETE',
      headers: { origin: `http://localhost:${String(port)}`, host: `localhost:${String(port)}` },
    });
    expect(removed.status).toBe(200);
    expect(editor.calls).toEqual(['add Octo-Org/my.widgets_2', 'remove Octo-Org/my.widgets_2']);
  });

  it('leaves the name to the editor to judge, never decoding it', async () => {
    await send('/api/maintained-repositories/o/r/extra', { method: 'PUT', headers: origin() });
    await send('/api/maintained-repositories/o%2Fr', { method: 'PUT', headers: origin() });
    await send('/api/maintained-repositories/', { method: 'DELETE', headers: origin() });

    expect(editor.calls).toEqual(['add o/r/extra', 'add o%2Fr', 'remove ']);
  });

  it('answers a refusal of the editor with its status and its message', async () => {
    editor.failure = new WatchListError(404, 'o/r was not found on GitHub.');

    for (const response of [
      await send('/api/maintained-repositories/o/r', { method: 'PUT', headers: origin() }),
      await send('/api/repositories'),
    ]) {
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: 'o/r was not found on GitHub.' });
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expectSecurityHeaders(response.headers);
    }
  });

  it('answers a bare 500 to anything else, and logs it', async () => {
    editor.failure = new Error('secret detail');

    const response = await send('/api/maintained-repositories/o/r', {
      method: 'PUT',
      headers: origin(),
    });

    expect(response).toMatchObject({ status: 500, body: 'Internal Server Error\n' });
    expect(logs.join('\n')).toContain('secret detail');
  });

  it.each([
    ['no Origin', {}],
    ['the Origin of another site', { origin: 'https://attacker.example' }],
    ['another port of this machine', { origin: 'http://127.0.0.1:1' }],
    ['a null Origin', { origin: 'null' }],
  ])('refuses a change with %s', async (_, headers) => {
    for (const method of ['PUT', 'DELETE']) {
      const response = await send('/api/maintained-repositories/o/r', { method, headers });
      expect(response).toMatchObject({ status: 403, body: 'Forbidden\n' });
    }
    expect(editor.calls).toEqual([]);
  });

  it('refuses a change the browser marks as coming from another site', async () => {
    const response = await send('/api/maintained-repositories/o/r', {
      method: 'PUT',
      headers: { ...origin(), 'sec-fetch-site': 'cross-site' },
    });

    expect(response.status).toBe(403);
    expect(
      (await send('/api/repositories', { headers: { 'sec-fetch-site': 'same-site' } })).status,
    ).toBe(403);
    expect(editor.calls).toEqual([]);
  });

  it('refuses a change sent to another host name (DNS rebinding)', async () => {
    const response = await send('/api/maintained-repositories/o/r', {
      method: 'PUT',
      headers: { host: 'attacker.example', origin: 'http://attacker.example' },
    });

    expect(response.status).toBe(403);
    expect(editor.calls).toEqual([]);
  });

  it('accepts a change from the page served under an allowed host', async () => {
    const response = await send('/api/maintained-repositories/o/r', {
      method: 'PUT',
      headers: { host: 'viewer.example.ts.net', origin: 'https://viewer.example.ts.net' },
    });

    expect(response.status).toBe(200);
    expect(editor.calls).toEqual(['add o/r']);
  });

  it.each(['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'])(
    'answers 405 to %s on a maintained repository',
    async (method) => {
      const response = await send('/api/maintained-repositories/o/r', {
        method,
        headers: origin(),
      });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('PUT, DELETE');
      expect(editor.calls).toEqual([]);
    },
  );

  it('still answers 405 to changes anywhere else', async () => {
    for (const path of ['/api/repositories', '/api/snapshot', '/']) {
      const response = await send(path, { method: 'PUT', headers: origin() });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('GET, HEAD');
    }
  });
});

describe('ViewerServer session routing', () => {
  it('isolates snapshots and live updates, and disconnects a revoked session', async () => {
    await server.close();
    const aliceSource = new FakeSource();
    const bobSource = new FakeSource();
    aliceSource.json = '{"repo":"alice/private"}';
    bobSource.json = '{"repo":"bob/private"}';
    const aliceAbort = new AbortController();
    const alice = { source: aliceSource, signal: aliceAbort.signal };
    const bob = { source: bobSource };
    const publicOrigin = new URL('https://viewer.example');
    const headers = { host: publicOrigin.host };
    const aliceHeaders = { ...headers, cookie: 'session=alice' };
    const bobHeaders = { ...headers, cookie: 'session=bob' };
    server = new ViewerServer({
      staticRoot: root,
      log: (line) => logs.push(line),
      sessions: {
        publicOrigin,
        resolve: (request) => {
          if (request.headers.cookie === 'session=alice') return alice;
          if (request.headers.cookie === 'session=bob') return bob;
          return null;
        },
        handlePage: () => Promise.resolve(false),
        maxStreamsPerContext: 1,
      },
    });
    port = await server.listen(0);

    expect((await send('/api/snapshot', { headers })).status).toBe(401);
    expect((await send('/api/repositories', { headers })).status).toBe(401);
    expect((await send('/api/events', { headers })).status).toBe(401);
    expect((await send('/api/snapshot', { headers: aliceHeaders })).body).toBe(aliceSource.json);
    expect((await send('/api/snapshot', { headers: bobHeaders })).body).toBe(bobSource.json);
    const aliceStream = await openStream(aliceHeaders);
    const bobStream = await openStream(bobHeaders);
    expect((await send('/api/events', { headers: aliceHeaders })).status).toBe(503);
    aliceSource.json = '{"repo":"alice/other"}';
    aliceSource.emit(true);
    await vi.waitFor(() => {
      expect(aliceStream.events).toContainEqual({
        event: 'payload',
        data: aliceSource.json,
      });
    });
    expect(bobStream.events).toEqual([{ event: 'payload', data: bobSource.json }]);

    aliceAbort.abort();
    await vi.waitFor(() => {
      expect(aliceStream.res.complete).toBe(true);
    });
    expect(aliceStream.events.at(-1)?.event).toBe('auth');
    expect(aliceSource.listeners.size).toBe(0);
    expect((await send('/api/snapshot', { headers: aliceHeaders })).status).toBe(401);
    expect(bobStream.res.complete).toBe(false);
    bobStream.close();
  });
});
