import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, isValidHost, ViewerServer } from './http.ts';
import type { Heartbeat } from './payload.ts';
import type { PayloadSource } from './store.ts';

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
async function openStream(): Promise<{
  res: IncomingMessage;
  events: { event: string; data: string }[];
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: string }[] = [];
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/events', headers: { host: host() } },
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
