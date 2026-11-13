// `pnpm run snapshot [--json]`: collects one snapshot from the live GitHub API and prints it.
// A manual check of the GitHub client until the server arrives; it reads `config.json` from the
// repository root if there is one, and uses the defaults otherwise.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, formatConfigIssues, parseConfig, type Config } from '../core/config.ts';
import { GitHubClient } from '../github/client.ts';
import { collectSnapshot } from '../github/collect.ts';
import { resolveToken } from '../github/token.ts';
import { formatCollection } from './format-snapshot.ts';

const CONFIG_FILE = new URL('../../config.json', import.meta.url);

async function readConfig(): Promise<Config> {
  let text: string;
  try {
    text = await readFile(CONFIG_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw error;
  }
  const result = parseConfig(JSON.parse(text));
  if (!result.ok) {
    throw new Error(`Invalid config.json:\n${formatConfigIssues(result.issues)}`);
  }
  return result.config;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });
  const config = await readConfig();
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
