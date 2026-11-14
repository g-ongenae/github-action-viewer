import { realpath, readFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import type { Log } from './log.ts';
import type { EventName } from './payload.ts';
import type { PayloadSource } from './store.ts';

/** The only interface the server listens on: never reachable from another machine. */
export const HOST = '127.0.0.1';

/** Interval between two heartbeats on the event stream. */
export const HEARTBEAT_MS = 15_000;

/** Concurrent event-stream clients; more are refused with 503. */
export const MAX_EVENT_CLIENTS = 16;

/** A client that does not read its stream is dropped once this much is waiting for it. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Same-origin only: scripts, styles, images and `fetch`/`EventSource` from the page's own origin,
 * nothing inline, no plugins, no framing, no form submission.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Sent with every response. */
const SECURITY_HEADERS: OutgoingHttpHeaders = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface ViewerServerOptions {
  readonly source: PayloadSource;
  /** Absolute path of the directory holding the page's static files. */
  readonly staticRoot: string;
  readonly log: Log;
  readonly heartbeatMs?: number;
  readonly maxEventClients?: number;
  /**
   * Extra `Host` values (`name` or `name:port`, as the browser sends them) the server answers to,
   * e.g. the name of a reverse proxy such as `tailscale serve`; the matching `http://` and
   * `https://` origins are accepted too. Loopback names are always accepted.
   */
  readonly allowedHosts?: readonly string[];
}

/**
 * The local HTTP server: the page's static files, `GET /api/snapshot` and the `GET /api/events`
 * stream. It listens on the loopback interface only and only answers same-origin requests that
 * name it by a loopback host name or an allowed host, so that other web pages open in the browser
 * cannot read it (see the README's security section). Opening the page itself from a link on
 * another site is a navigation, not a read, and is let through.
 */
export class ViewerServer {
  readonly #options: ViewerServerOptions;
  readonly #server: Server;
  readonly #clients = new Set<ServerResponse>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;
  #port = 0;

  constructor(options: ViewerServerOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        options.log(`Error while answering ${request.method ?? '?'} request: ${String(error)}`);
        if (!response.headersSent) {
          sendText(response, 500, 'Internal Server Error');
        } else {
          response.destroy();
        }
      });
    });
  }

  /** The port actually listened on (useful with port 0). */
  get port(): number {
    return this.#port;
  }

  /** Listens on {@link HOST}; rejects with the `listen` error, e.g. `EADDRINUSE`. */
  async listen(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: HOST, port, exclusive: true }, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    this.#unsubscribe = this.#options.source.subscribe((changed) => {
      this.#broadcast(changed ? 'payload' : 'heartbeat');
    });
    this.#heartbeat = setInterval(() => {
      this.#broadcast('heartbeat');
    }, this.#options.heartbeatMs ?? HEARTBEAT_MS);
    this.#heartbeat.unref();
    return this.#port;
  }

  /** Ends the event streams, drops idle connections and stops listening. */
  async close(): Promise<void> {
    this.#unsubscribe?.();
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
    }
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
    const closed = new Promise<void>((resolve) =>
      this.#server.close(() => {
        resolve();
      }),
    );
    this.#server.closeAllConnections();
    await closed;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#isAllowedHost(request.headers.host)) {
      sendText(response, 403, 'Forbidden');
      return;
    }
    if (isCrossSite(request, this.#origins) && !isPageNavigation(request)) {
      sendText(response, 403, 'Forbidden');
      return;
    }
    const method = request.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }

    // The path as sent, without the query; never parsed against a base URL, which would accept
    // `//other-host/…` as an absolute URL.
    const path = (request.url ?? '').split('?', 1)[0] ?? '';
    if (!path.startsWith('/')) {
      sendText(response, 400, 'Bad Request');
      return;
    }

    if (path === '/api/snapshot') {
      send(response, 200, this.#options.source.payloadJson(), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } else if (path === '/api/events') {
      this.#openStream(request, response);
    } else if (path.startsWith('/api/')) {
      sendText(response, 404, 'Not Found');
    } else {
      await this.#serveStatic(path, response);
    }
  }

  /**
   * DNS rebinding defence: a page on `http://attacker.example:4680` whose name was re-pointed to
   * 127.0.0.1 reaches this server with `Host: attacker.example:4680`, and is refused.
   */
  #isAllowedHost(host: string | undefined): boolean {
    return host !== undefined && this.#origins.has(`http://${host.toLowerCase()}`);
  }

  /** The origins (and, without the scheme, the `Host` values) under which the server is reached. */
  get #origins(): Set<string> {
    const port = String(this.#port);
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    for (const host of this.#options.allowedHosts ?? []) {
      origins.add(`http://${host.toLowerCase()}`);
      origins.add(`https://${host.toLowerCase()}`);
    }
    return origins;
  }

  #openStream(request: IncomingMessage, response: ServerResponse): void {
    const max = this.#options.maxEventClients ?? MAX_EVENT_CLIENTS;
    if (this.#clients.size >= max) {
      sendText(response, 503, 'Too many open streams', { 'Retry-After': '30' });
      return;
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Tells any buffering proxy to pass events through at once.
      'X-Accel-Buffering': 'no',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    this.#clients.add(response);
    response.on('close', () => this.#clients.delete(response));
    // Reconnection delay for EventSource, then the current payload.
    response.write('retry: 5000\n\n');
    this.#send(response, 'payload');
  }

  #broadcast(event: EventName): void {
    for (const client of this.#clients) {
      this.#send(client, event);
    }
  }

  #send(client: ServerResponse, event: EventName): void {
    if (client.writableLength > MAX_BUFFERED_BYTES) {
      client.destroy();
      return;
    }
    const { source } = this.#options;
    const data = event === 'payload' ? source.payloadJson() : JSON.stringify(source.heartbeat());
    // JSON.stringify never emits a raw newline, so the data fits on one `data:` line.
    client.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  async #serveStatic(path: string, response: ServerResponse): Promise<void> {
    const file = await resolveStaticFile(this.#options.staticRoot, path);
    if (file === null) {
      sendText(response, 404, 'Not Found');
      return;
    }
    const body = await readFile(file);
    send(response, 200, body, {
      'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // Revalidate every time: the files change whenever the page is rebuilt.
      'Cache-Control': 'no-cache',
    });
  }
}

/** A `Host` value: a DNS name or IPv4 address, with an optional port. */
const HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

/** Whether `value` can be passed in {@link ViewerServerOptions.allowedHosts}. */
export function isValidHost(value: string): boolean {
  return HOST_PATTERN.test(value);
}

/**
 * Whether the browser says the request comes from another site: `Sec-Fetch-Site` other than
 * `same-origin` or `none` (typed in the address bar), or an `Origin` that is not this server.
 * Requests without these headers (curl, old browsers) are let through; the `Host` check still
 * applies to them.
 */
function isCrossSite(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return true;
  }
  const origin = request.headers.origin;
  return origin !== undefined && !origins.has(origin.toLowerCase());
}

/**
 * Whether the browser is opening a page of the viewer in a tab, e.g. after a click on a link from
 * another site. The other site cannot read the answer (no CORS, no framing), so it is safe to
 * serve; reads of `/api/` from another site are still refused.
 */
function isPageNavigation(request: IncomingMessage): boolean {
  return (
    request.method === 'GET' &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' &&
    request.headers.origin === undefined &&
    !(request.url ?? '').startsWith('/api/')
  );
}

/**
 * Maps a URL path to a regular file under `root`, or null. Refuses anything that could leave the
 * root or reveal hidden files: undecodable paths, NUL bytes, backslashes, empty segments, and
 * segments starting with a dot (`..`, `.env`, `.git`); then checks the real path, symbolic links
 * resolved, is still inside the root. `/` serves `index.html`.
 */
export async function resolveStaticFile(root: string, path: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path === '/' ? '/index.html' : path);
  } catch {
    return null;
  }
  const segments = decoded.slice(1).split('/');
  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    segments.some((segment) => segment === '' || segment.startsWith('.'))
  ) {
    return null;
  }
  try {
    const realRoot = await realpath(root);
    const file = await realpath(join(realRoot, ...segments));
    if (!file.startsWith(realRoot + sep) || !(await stat(file)).isFile()) {
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: OutgoingHttpHeaders,
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

/** A short, generic plain-text answer: errors never carry details. */
function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: OutgoingHttpHeaders = {},
): void {
  send(response, status, `${text}\n`, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}
