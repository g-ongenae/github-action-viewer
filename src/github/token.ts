import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Where the token came from. */
export type TokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh auth token';

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
}

export interface TokenResolutionOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Prints the token of the GitHub CLI; defaults to running `gh auth token`. */
  readonly ghAuthToken?: () => Promise<string>;
}

/** No token could be found. The message says how to provide one. */
export class TokenNotFoundError extends Error {
  constructor(ghFailure: string) {
    super(
      [
        'No GitHub token found. Either:',
        '  - set GITHUB_TOKEN (or GH_TOKEN) to a token that can read your repositories and their Actions runs, or',
        '  - install the GitHub CLI and run `gh auth login`.',
        `(\`gh auth token\` failed: ${ghFailure})`,
      ].join('\n'),
    );
    this.name = 'TokenNotFoundError';
  }
}

/** Finds a token: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. */
export async function resolveToken(options: TokenResolutionOptions = {}): Promise<ResolvedToken> {
  const env = options.env ?? process.env;
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const token = env[name]?.trim();
    if (token) {
      return { token, source: name };
    }
  }

  let output: string;
  try {
    output = await (options.ghAuthToken ?? ghAuthToken)();
  } catch (error) {
    throw new TokenNotFoundError(describeGhFailure(error));
  }
  const token = output.trim();
  if (token === '') {
    throw new TokenNotFoundError('it printed nothing');
  }
  return { token, source: 'gh auth token' };
}

/** Runs `gh auth token` without a shell, with a timeout, and returns what it prints. */
async function ghAuthToken(): Promise<string> {
  const { stdout } = await promisify(execFile)('gh', ['auth', 'token'], {
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout;
}

function describeGhFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, killed } = error as { code?: unknown; killed?: unknown };
    if (code === 'ENOENT') {
      return 'the GitHub CLI (gh) is not installed or not on the PATH';
    }
    if (killed === true) {
      return 'it timed out';
    }
    if (typeof code === 'number') {
      return `it exited with code ${String(code)}; is \`gh auth login\` done?`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
