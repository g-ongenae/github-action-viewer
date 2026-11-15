import { describe, expect, it } from 'vitest';
import type { CatalogueRepository } from '../server/payload.ts';
import { normaliseQuery, suggest } from './suggestions.ts';

const repo = (fullName: string, isPrivate = false): CatalogueRepository => ({
  fullName,
  private: isPrivate,
});

/** Most recently pushed first, as the server sends them. */
const CATALOGUE = [
  repo('octocat/dotfiles', true),
  repo('Octo-Org/widgets'),
  repo('octo-org/widgets-docs'),
  repo('other-org/api', true),
  repo('octocat/api-client'),
];

const names = (query: string, maintained: readonly string[] = [], limit?: number): string[] =>
  suggest(query, CATALOGUE, maintained, limit).matches.map((match) => match.fullName);

describe('normaliseQuery', () => {
  it.each([
    ['  octo-org/widgets ', 'octo-org/widgets'],
    ['https://github.com/octo-org/widgets', 'octo-org/widgets'],
    ['https://github.com/octo-org/widgets/', 'octo-org/widgets'],
    ['https://github.com/octo-org/widgets/actions/runs/12?check=1#top', 'octo-org/widgets'],
    ['http://www.github.com/octo-org/widgets.git', 'octo-org/widgets'],
    ['github.com/Octo-Org/Widgets', 'Octo-Org/Widgets'],
    ['git@github.com:octo-org/widgets.git', 'octo-org/widgets'],
    ['https://example.com/octo-org/widgets', 'https://example.com/octo-org/widgets'],
    ['https://github.com/octo-org', 'https://github.com/octo-org'],
    ['wid', 'wid'],
    ['', ''],
  ])('reads %o as %o', (input, expected) => {
    expect(normaliseQuery(input)).toBe(expected);
  });
});

describe('suggest', () => {
  it('offers the most recently pushed repositories for an empty query', () => {
    expect(suggest('', CATALOGUE, [], 3)).toEqual({
      matches: CATALOGUE.slice(0, 3),
      more: 2,
      typed: null,
      alreadyAdded: null,
    });
  });

  it('matches anywhere in the name, whatever the case, names starting with the query first', () => {
    expect(names('API')).toEqual(['other-org/api', 'octocat/api-client']);
    expect(names('octo-org')).toEqual(['Octo-Org/widgets', 'octo-org/widgets-docs']);
    expect(names('docs')).toEqual(['octo-org/widgets-docs']);
    // The owner of `dotfiles` only contains the query; the names of the others start with it.
    expect(names('a')).toEqual(['other-org/api', 'octocat/api-client', 'octocat/dotfiles']);
    expect(names('d')).toEqual(['octocat/dotfiles', 'Octo-Org/widgets', 'octo-org/widgets-docs']);
  });

  it('wants every word of the query', () => {
    expect(names('octo widgets')).toEqual(['Octo-Org/widgets', 'octo-org/widgets-docs']);
    expect(names('octo nothing')).toEqual([]);
  });

  it('leaves out the repositories already added', () => {
    expect(names('widgets', ['OCTO-ORG/WIDGETS'])).toEqual(['octo-org/widgets-docs']);
  });

  it('puts an exact name first and does not offer it twice', () => {
    const offered = suggest('octo-org/widgets', CATALOGUE, []);
    expect(offered.matches.map((match) => match.fullName)).toEqual([
      'Octo-Org/widgets',
      'octo-org/widgets-docs',
    ]);
    expect(offered.typed).toBeNull();
  });

  it('offers a full name that the catalogue does not list, as it was typed', () => {
    expect(suggest(' Someone/Public-Thing ', CATALOGUE, [])).toEqual({
      matches: [],
      more: 0,
      typed: 'Someone/Public-Thing',
      alreadyAdded: null,
    });
    // A name that only starts like a listed one is still its own repository.
    expect(suggest('octo-org/widget', CATALOGUE, []).typed).toBe('octo-org/widget');
    expect(suggest('octo-org/', CATALOGUE, []).typed).toBeNull();
    expect(suggest('widgets', CATALOGUE, []).typed).toBeNull();
  });

  it('reads a pasted GitHub address as the repository it names', () => {
    const offered = suggest('https://github.com/octo-org/widgets/pull/7', CATALOGUE, []);
    expect(offered.matches[0]?.fullName).toBe('Octo-Org/widgets');
    expect(suggest('https://github.com/someone/thing', CATALOGUE, []).typed).toBe('someone/thing');
  });

  it('says when the typed repository is already added', () => {
    expect(suggest('octo-org/WIDGETS', CATALOGUE, ['Octo-Org/widgets'])).toMatchObject({
      typed: null,
      alreadyAdded: 'octo-org/WIDGETS',
    });
  });

  it('counts what the limit leaves out', () => {
    expect(suggest('o', CATALOGUE, [], 2)).toMatchObject({ more: 3 });
    expect(suggest('o', CATALOGUE, [], 5)).toMatchObject({ more: 0 });
  });
});
