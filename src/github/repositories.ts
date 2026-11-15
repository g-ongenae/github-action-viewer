// Repositories outside a collection: the ones the token can read, to offer them to the reader,
// and one repository by name, to check it before it is added to the watch list.

import type { GitHubClient, RequestOptions } from './client.ts';
import { GitHubError } from './errors.ts';
import {
  parseAccessibleRepositoryList,
  parseRepository,
  type AccessibleRepository,
  type RepositoryInfo,
} from './mapping.ts';

/** Pages of the user's repositories read for {@link listAccessibleRepositories} (100 per page). */
export const ACCESSIBLE_PAGES = 10;

export interface AccessibleRepositories {
  /** Most recently pushed first, without duplicates. */
  readonly repositories: AccessibleRepository[];
  /** False when a page after the first failed, or the page cap was reached. */
  readonly complete: boolean;
}

/** Path of a repository in the API: `/repos/{owner}/{name}`. */
export function repositoryPath(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * The repositories GitHub lists for the token's user: owned, collaborated on, and reached through
 * an organization, public and private, neither archived nor disabled. A public repository of
 * someone else is not listed, although the token can read it: {@link lookUpRepository} finds it.
 *
 * A failure on the first page is thrown; a later one keeps the pages already read.
 */
export async function listAccessibleRepositories(
  client: GitHubClient,
  options: RequestOptions = {},
): Promise<AccessibleRepositories> {
  const repositories = new Map<string, AccessibleRepository>();
  let complete = false;
  let pagesRead = 0;
  try {
    const pages = client.pages(
      '/user/repos',
      {
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'pushed',
        direction: 'desc',
        per_page: 100,
      },
      parseAccessibleRepositoryList,
      { maxPages: ACCESSIBLE_PAGES, ...options },
    );
    for await (const page of pages) {
      pagesRead += 1;
      for (const repository of page.data) {
        // A push between two pages can list a repository twice.
        if (!repositories.has(repository.fullName.toLowerCase())) {
          repositories.set(repository.fullName.toLowerCase(), repository);
        }
      }
      complete = !page.hasNext;
    }
  } catch (error) {
    if (!(error instanceof GitHubError) || pagesRead === 0) {
      throw error;
    }
    complete = false;
  }
  return { repositories: [...repositories.values()], complete };
}

/**
 * One repository by name, as GitHub knows it now: an old name is answered under the current one.
 * Throws a `NotFoundError` when it does not exist or the token cannot read it.
 */
export function lookUpRepository(
  client: GitHubClient,
  fullName: string,
  options: RequestOptions = {},
): Promise<RepositoryInfo> {
  return client.get(repositoryPath(fullName), {}, parseRepository, options);
}
