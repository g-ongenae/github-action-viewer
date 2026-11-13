// Links to GitHub. Every URL the page receives comes from the GitHub API through the server, but
// it ends up in an `href`, so the page only emits links it can vouch for: `https://github.com/…`.
// Anything else (`javascript:`, another host, credentials in the URL) is dropped, and the text
// is shown without a link.

/**
 * The URL, normalised, if it is an `https://github.com/` URL without credentials or an explicit
 * port; null otherwise.
 */
export function safeGitHubUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  return parsed.href;
}

/**
 * The Actions page of a repository filtered on one branch, built from the repository's URL;
 * null if that URL is not a safe GitHub URL.
 */
export function branchRunsUrl(repositoryUrl: string, branch: string): string | null {
  const base = safeGitHubUrl(repositoryUrl);
  if (base === null) {
    return null;
  }
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/actions`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('query', `branch:${branch}`);
  return safeGitHubUrl(url.href);
}
