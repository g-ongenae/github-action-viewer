// `pnpm start`: the local server. Resolves the token, loads the configuration, then serves the
// page on http://127.0.0.1:<port>/ while collecting from GitHub in the background.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Config } from '../core/config.ts';
import { GitHubClient } from '../github/client.ts';
import { collectSnapshot } from '../github/collect.ts';
import { MalformedTokenError } from '../github/errors.ts';
import { resolveToken, TokenNotFoundError } from '../github/token.ts';
import { CollectionLog } from './collection-log.ts';
import { CONFIG_PATH_VARIABLE, ConfigFile, configPath } from './config-file.ts';
import { HOST, isValidHost, ViewerServer } from './http.ts';
import { createLog } from './log.ts';
import { Poller } from './poller.ts';
import { PayloadStore } from './store.ts';
import { ConfigWatchListEditor } from './watch-list-editor.ts';

const STATIC_ROOT = fileURLToPath(new URL('../../dist/web/', import.meta.url));

/** How long shutting down may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

const USAGE = `Usage: pnpm start [--port <port>] [--config <path>] [--allowed-host <host>]...
                 [--read-only] [--demo [--demo-variant <name>]]

Serves a page showing the GitHub Actions runs you care about, on http://${HOST}:<port>/.

Options:
  -p, --port <port>    Port to listen on (default: "port" in the configuration, 4680).
  -c, --config <path>  Configuration file (default: $${CONFIG_PATH_VARIABLE}, or config.json
                       at the repository root). Changes apply without a restart.
  --allowed-host <host>
                       Also answer to this Host, as the browser sends it (name, or
                       name:port), e.g. behind \`tailscale serve\`. Repeatable.
  --read-only          Do not let the page add or remove repositories: the configuration
                       file is never written.
  --demo               Serve made-up data instead of collecting from GitHub (no token, no
                       configuration): every state the page can show.
  --demo-variant <name>
                       With --demo: full (default), failing, empty or first-load.
  -h, --help           Show this help.

The GitHub token is read from GITHUB_TOKEN, then GH_TOKEN, then \`gh auth token\`.
`;

interface Options {
  readonly port: number | undefined;
  readonly config: string | undefined;
  /** Extra `Host` values to answer to, from `--allowed-host`. */
  readonly allowedHosts: readonly string[];
  /** Whether the page may not edit the watch list, from `--read-only`. */
  readonly readOnly: boolean;
  /** The demo variant to serve; undefined outside demo mode. */
  readonly demo: string | undefined;
}

/** Parses the command line; null after printing the help. Throws on invalid arguments. */
function parseOptions(args: readonly string[]): Options | null {
  const { values } = parseArgs({
    args: [...args],
    options: {
      port: { type: 'string', short: 'p' },
      config: { type: 'string', short: 'c' },
      'allowed-host': { type: 'string', multiple: true },
      'read-only': { type: 'boolean' },
      demo: { type: 'boolean' },
      'demo-variant': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return null;
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1 || port > 65_535) {
      throw new Error(`--port: expected an integer between 1 and 65535, got "${values.port}"`);
    }
  }
  if (values['demo-variant'] !== undefined && values.demo !== true) {
    throw new Error('--demo-variant: only valid with --demo');
  }
  const allowedHosts = values['allowed-host'] ?? [];
  for (const host of allowedHosts) {
    if (!isValidHost(host)) {
      throw new Error(`--allowed-host: expected a host name, optionally with :port, got "${host}"`);
    }
  }
  const demo = values.demo === true ? (values['demo-variant'] ?? 'full') : undefined;
  return {
    port,
    config: values.config,
    allowedHosts,
    readOnly: values['read-only'] === true,
    demo,
  };
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options === null) {
    return 0;
  }

  const log = createLog();
  if (options.demo !== undefined) {
    // Loaded only here, so that demo code never runs, or even loads, in normal mode.
    const { serveDemo } = await import('../demo/serve.ts');
    return serveDemo({
      variant: options.demo,
      port: options.port,
      allowedHosts: options.allowedHosts,
      readOnly: options.readOnly,
      staticRoot: STATIC_ROOT,
      log,
    });
  }
  const collectionLog = new CollectionLog(log);
  let listeningPort = 0;
  let warnedPort: number | null = null;

  const configFile: ConfigFile = new ConfigFile(configPath(options.config), {
    log,
    readOnly: options.readOnly,
    onChange: ({ configChanged }) => {
      store.setConfigStatus(configFile.status);
      if (configChanged) {
        warnAboutPort(configFile.config);
        poller.pollNow();
      }
    },
  });
  await configFile.load();

  /** A new port cannot apply to a running server: say so once per value. */
  function warnAboutPort(config: Config): void {
    if (
      options?.port === undefined &&
      config.port !== listeningPort &&
      config.port !== warnedPort
    ) {
      warnedPort = config.port;
      log(
        `The configured port is now ${String(config.port)}; restart to use it (still listening on ${String(listeningPort)}).`,
      );
    }
  }

  let resolved;
  try {
    resolved = await resolveToken();
  } catch (error) {
    // Only the project's own token errors are printed: they say what to do and hold no secret.
    process.stderr.write(
      `${error instanceof TokenNotFoundError || error instanceof MalformedTokenError ? error.message : 'Could not get a GitHub token.'}\n`,
    );
    return 1;
  }
  const client = new GitHubClient({ token: resolved.token });

  const poller: Poller = new Poller({
    collect: (config, signal) => collectSnapshot(client, config, { now: new Date(), signal }),
    config: () => configFile.config,
    onUpdate: (state, outcome) => {
      const changed = store.setPollState(state);
      if (outcome !== null) {
        collectionLog.record(outcome, state, changed);
      }
    },
  });
  const store = new PayloadStore(poller.state, configFile.status);
  const watchList = new ConfigWatchListEditor({
    client,
    configFile,
    rateLimitedUntil: () => {
      const retryAt = poller.state.status.rateLimits.retryAt;
      return retryAt === null ? null : Date.parse(retryAt);
    },
    onRateLimit: (retryAt) => {
      poller.holdUntil(retryAt);
    },
  });
  const server = new ViewerServer({
    source: store,
    staticRoot: STATIC_ROOT,
    log,
    allowedHosts: options.allowedHosts,
    ...(options.readOnly ? {} : { watchList }),
  });

  const port = options.port ?? configFile.config.port;
  try {
    listeningPort = await server.listen(port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(
      code === 'EADDRINUSE'
        ? `Port ${String(port)} is already in use (is the viewer already running?). Choose another one with --port or the "port" key of the configuration.\n`
        : `Cannot listen on ${HOST}:${String(port)}: ${(error as Error).message}\n`,
    );
    return 1;
  }

  if (!existsSync(`${STATIC_ROOT}index.html`)) {
    log('The page is not built: run `pnpm run build:web` (`pnpm start` does it).');
  }
  log(`Serving http://${HOST}:${String(listeningPort)}/ (token from ${resolved.source})`);
  poller.start();
  configFile.watch();

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    log(`Stopping (${signal})…`);
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    configFile.close();
    void Promise.all([poller.stop(), server.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) {
      process.exit(code);
    }
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
