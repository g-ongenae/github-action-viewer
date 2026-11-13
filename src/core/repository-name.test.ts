import { describe, expect, it } from 'vitest';

import { isRepositoryName, nameKey, sameName } from './repository-name.ts';

describe('isRepositoryName', () => {
  it.each([
    'octo-org/widgets',
    'Octocat/Hello-World',
    'a/b',
    'octo-org/widgets.js',
    'octo/.github',
    'octo/_x',
  ])('accepts %j', (name) => {
    expect(isRepositoryName(name)).toBe(true);
  });

  it.each([
    'widgets',
    'octo-org/',
    '/widgets',
    'octo-org/widgets/extra',
    '-octo/widgets',
    'octo org/widgets',
    'octo/.',
    'octo/..',
    '',
  ])('rejects %j', (name) => {
    expect(isRepositoryName(name)).toBe(false);
  });
});

describe('nameKey / sameName', () => {
  it('compares names case-insensitively', () => {
    expect(nameKey('Octo-Org/Widgets')).toBe('octo-org/widgets');
    expect(sameName('Octo-Org/Widgets', 'octo-org/widgets')).toBe(true);
    expect(sameName('octo-org/widgets', 'octo-org/gadgets')).toBe(false);
  });

  it('never matches an unknown name', () => {
    expect(sameName(null, null)).toBe(false);
    expect(sameName('octocat', null)).toBe(false);
  });
});
