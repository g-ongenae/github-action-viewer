// `pnpm demo` (`pnpm start --demo`): the real HTTP server and page, fed with synthetic data. No
// token, no configuration file and no request to GitHub.

import { DEFAULT_CONFIG } from '../core/config.ts';
import { HOST, ViewerServer } from '../server/http.ts';
import type { Log } from '../server/log.ts';
import { DEMO_VARIANTS, type DemoVariant } from './payload.ts';
import { DemoSource } from './source.ts';

export interface DemoOptions {
  readonly variant: string;
  /** Port from `--port`; the default port otherwise (the configuration file is not read). */
  readonly port: number | undefined;
  readonly staticRoot: string;
  readonly log: Log;
}

/** Serves the demo until SIGINT or SIGTERM; resolves to an exit code (non-zero on failure). */
export async function serveDemo(options: DemoOptions): Promise<number> {
  if (!isDemoVariant(options.variant)) {
    process.stderr.write(
      `--demo-variant: expected one of ${DEMO_VARIANTS.join(', ')}, got "${options.variant}"\n`,
    );
    return 2;
  }
  const source = new DemoSource(options.variant);
  const server = new ViewerServer({ source, staticRoot: options.staticRoot, log: options.log });
  const port = options.port ?? DEFAULT_CONFIG.port;
  let listening: number;
  try {
    listening = await server.listen(port);
  } catch (error) {
    process.stderr.write(`Cannot listen on ${HOST}:${String(port)}: ${(error as Error).message}\n`);
    return 1;
  }
  source.start();
  options.log(
    `Demo mode (${options.variant}): serving made-up data on http://${HOST}:${String(listening)}/`,
  );

  const shutdown = (): void => {
    source.stop();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

function isDemoVariant(name: string): name is DemoVariant {
  return (DEMO_VARIANTS as readonly string[]).includes(name);
}
