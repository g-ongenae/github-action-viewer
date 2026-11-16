// What the "Add a repository" dialog offers for what was typed: the repositories of the catalogue
// that match, and the typed name itself when it is a full `owner/name`. Pure functions of the
// query and the lists; the dialog turns them into DOM.

import { isRepositoryName, nameKey } from '../core/repository-name.ts';
import type { CatalogueRepository } from '../server/payload.ts';

/** Suggestions shown at once; the rest is reached by typing more. */
export const SUGGESTION_LIMIT = 8;

export interface Suggestions {
  /** Matching repositories that are not added yet, best first; at most the limit. */
  readonly matches: readonly CatalogueRepository[];
  /** Matching repositories left out by the limit. */
  readonly more: number;
  /**
   * The query as a repository name (`owner/name`) when it is one that is neither added yet nor
   * the first match: it may be a repository the catalogue does not list. Null otherwise.
   */
  readonly typed: string | null;
  /** The query as a repository name when that repository is already added; null otherwise. */
  readonly alreadyAdded: string | null;
}

/**
 * What was typed or pasted, as a search text: trimmed, and reduced to `owner/name` for the URL
 * of a repository on github.com (or of a page inside it) and for a `git@github.com:` address.
 */
export function normaliseQuery(input: string): string {
  const text = input.trim();
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:[/?#].*)?$/i.exec(text) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(text);
  if (match === null) {
    return text;
  }
  const [, owner = '', name = ''] = match;
  return `${owner}/${name.replace(/\.git$/i, '')}`;
}

/**
 * Suggestions for `query` among `catalogue` (in the server's order, most recently pushed first),
 * leaving out the `maintained` repositories. Every word of the query must appear in the name;
 * an exact name comes first, then names starting with the query (with or without the owner),
 * then the others. An empty query suggests the first repositories of the catalogue.
 */
export function suggest(
  query: string,
  catalogue: readonly CatalogueRepository[],
  maintained: readonly string[],
  limit: number = SUGGESTION_LIMIT,
): Suggestions {
  const text = nameKey(normaliseQuery(query));
  const words = text.split(/\s+/).filter((word) => word !== '');
  const added = new Set(maintained.map(nameKey));

  const rank = (repository: CatalogueRepository): number => {
    const fullName = nameKey(repository.fullName);
    const name = fullName.slice(fullName.indexOf('/') + 1);
    if (fullName === text) {
      return 0;
    }
    return name.startsWith(text) || fullName.startsWith(text) ? 1 : 2;
  };
  const matching = catalogue
    .filter((repository) => {
      const fullName = nameKey(repository.fullName);
      return !added.has(fullName) && words.every((word) => fullName.includes(word));
    })
    .map((repository, index) => ({ repository, index, rank: rank(repository) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ repository }) => repository);

  const isName = isRepositoryName(text);
  const exact = isName && matching[0] !== undefined && nameKey(matching[0].fullName) === text;
  return {
    matches: matching.slice(0, limit),
    more: Math.max(0, matching.length - limit),
    typed: isName && !exact && !added.has(text) ? normaliseQuery(query) : null,
    alreadyAdded: isName && added.has(text) ? normaliseQuery(query) : null,
  };
}
