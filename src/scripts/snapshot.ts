// `pnpm run snapshot [--json] [--config <path>]`: collects one snapshot from the live GitHub API
// and prints it. It reads the same configuration file as the server, and uses the defaults if
// there is none.

import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, type Config } from '../core/config.ts';
import { GitHubClient } from '../github/client.ts';
import { collectSnapshot } from '../github/collect.ts';
import { resolveToken } from '../github/token.ts';
import { configPath, readConfigFile } from '../server/config-file.ts';
import { formatCollection } from './format-snapshot.ts';

async function readConfig(path: string): Promise<Config> {
  const read = await readConfigFile(path);
  switch (read.kind) {
    case 'missing':
      return DEFAULT_CONFIG;
    case 'ok':
      return read.config;
    case 'invalid':
      throw new Error(`Invalid configuration in ${path}:\n${read.problems}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      config: { type: 'string', short: 'c' },
    },
  });
  const config = await readConfig(configPath(values.config));
  const { token, source } = await resolveToken();
  const client = new GitHubClient({ token });
  const result = await collectSnapshot(client, config, { now: new Date() });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCollection(result)}\n(token from ${source})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
