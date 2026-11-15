// The page's calls to the server routes that edit the watch list. Failures never throw: they
// come back as a message for the reader.

import type { RepositoryCatalogue, WatchListChange } from '../server/payload.ts';

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  /** `message`: what went wrong, for the reader. */
  | { readonly ok: false; readonly message: string };

export interface WatchListApi {
  /** The repositories offered to add. */
  catalogue(): Promise<ApiResult<RepositoryCatalogue>>;
  /** Adds a repository (`owner/name`) to the maintained ones. */
  add(repository: string): Promise<ApiResult<WatchListChange>>;
  /** Removes a repository (`owner/name`) from the maintained ones. */
  remove(repository: string): Promise<ApiResult<WatchListChange>>;
}

/** The part of `fetch` used here, so that tests can provide their own. */
export type Fetch = (url: string, init: { readonly method: string }) => Promise<Response>;

/**
 * The API of the server the page came from. Repository names go in the path as they are: their
 * characters never need encoding, and the server refuses anything that is not a name.
 */
export function createWatchListApi(
  fetch: Fetch = (url, init) => globalThis.fetch(url, init),
): WatchListApi {
  const call = async <T>(method: string, url: string): Promise<ApiResult<T>> => {
    let response: Response;
    try {
      response = await fetch(url, { method });
    } catch {
      return { ok: false, message: 'Cannot reach the viewer’s server.' };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON (a plain-text error of the server): described from the status below.
    }
    if (response.ok && typeof body === 'object' && body !== null) {
      return { ok: true, value: body as T };
    }
    const error =
      typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
    return {
      ok: false,
      message:
        typeof error === 'string' && error !== ''
          ? error
          : `The viewer’s server refused the request (HTTP ${String(response.status)}).`,
    };
  };
  return {
    catalogue: () => call('GET', '/api/repositories'),
    add: (repository) => call('PUT', `/api/maintained-repositories/${repository}`),
    remove: (repository) => call('DELETE', `/api/maintained-repositories/${repository}`),
  };
}
