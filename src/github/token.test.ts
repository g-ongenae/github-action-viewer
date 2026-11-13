import { describe, expect, it, vi } from 'vitest';
import { resolveToken, TokenNotFoundError } from './token.ts';

const fromGh = (token: string) => vi.fn(() => Promise.resolve(token));

describe('resolveToken', () => {
  it('prefers GITHUB_TOKEN', async () => {
    const ghAuthToken = fromGh('gh');

    await expect(
      resolveToken({ env: { GITHUB_TOKEN: ' token-1\n', GH_TOKEN: 'token-2' }, ghAuthToken }),
    ).resolves.toEqual({ token: 'token-1', source: 'GITHUB_TOKEN' });
    expect(ghAuthToken).not.toHaveBeenCalled();
  });

  it('falls back to GH_TOKEN, skipping empty variables', async () => {
    await expect(
      resolveToken({ env: { GITHUB_TOKEN: '  ', GH_TOKEN: 'token-2' }, ghAuthToken: fromGh('gh') }),
    ).resolves.toEqual({ token: 'token-2', source: 'GH_TOKEN' });
  });

  it('falls back to the GitHub CLI', async () => {
    await expect(resolveToken({ env: {}, ghAuthToken: fromGh('token-3\n') })).resolves.toEqual({
      token: 'token-3',
      source: 'gh auth token',
    });
  });

  it.each([
    [Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), 'not installed'],
    [Object.assign(new Error('Command failed'), { code: 1 }), 'gh auth login'],
    [Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), 'timed out'],
  ])('explains how to provide a token when gh fails (%s)', async (failure, hint) => {
    const promise = resolveToken({ env: {}, ghAuthToken: () => Promise.reject(failure) });

    await expect(promise).rejects.toThrow(TokenNotFoundError);
    await expect(promise).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(promise).rejects.toThrow(hint);
  });

  it('rejects an empty output of gh', async () => {
    await expect(resolveToken({ env: {}, ghAuthToken: fromGh('\n') })).rejects.toThrow(
      /printed nothing/,
    );
  });
});
