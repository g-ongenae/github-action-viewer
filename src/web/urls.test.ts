import { describe, expect, it } from 'vitest';
import { branchRunsUrl, safeGitHubUrl } from './urls.ts';

describe('safeGitHubUrl', () => {
  it('accepts https://github.com URLs', () => {
    expect(safeGitHubUrl('https://github.com/octo-org/widgets/pull/7')).toBe(
      'https://github.com/octo-org/widgets/pull/7',
    );
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://github.com/octo-org/widgets',
    'https://github.com.evil.example/x',
    'https://evil.example/https://github.com/',
    'https://api.github.com/repos/x/y',
    'https://user:pass@github.com/x',
    'https://github.com:8443/x',
    '//github.com/x',
    '/octo-org/widgets',
    'not a url',
    '',
  ])('drops %j', (url) => {
    expect(safeGitHubUrl(url)).toBeNull();
  });
});

describe('branchRunsUrl', () => {
  it('links to the Actions page filtered on the branch, encoded', () => {
    expect(branchRunsUrl('https://github.com/octo-org/widgets', 'feature/a&b=c')).toBe(
      'https://github.com/octo-org/widgets/actions?query=branch%3Afeature%2Fa%26b%3Dc',
    );
  });

  it('gives null for a repository URL that is not on github.com', () => {
    expect(branchRunsUrl('javascript:alert(1)//', 'main')).toBeNull();
  });
});
