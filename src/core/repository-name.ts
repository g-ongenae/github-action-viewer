// GitHub owner and repository names, like logins, are case-insensitive: `Octo-Org/Widgets` and
// `octo-org/widgets` are the same repository. Every comparison goes through these helpers.

/** Matches `owner/name`: a GitHub account name, a slash, then a repository name. */
const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Whether a string looks like a repository full name (`owner/name`). */
export function isRepositoryName(value: string): boolean {
  return REPOSITORY_NAME.test(value) && !value.endsWith('/.') && !value.endsWith('/..');
}

/** Case-insensitive key for a repository full name or a login, for comparisons and lookups. */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

/** Whether two repository full names (or two logins) designate the same thing. */
export function sameName(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && nameKey(a) === nameKey(b);
}
