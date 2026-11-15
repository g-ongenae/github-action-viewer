import { describe, expect, it } from 'vitest';
import { GitHubClient } from './client.ts';
import { HttpError, NotFoundError } from './errors.ts';
import { listAccessibleRepositories, lookUpRepository, repositoryPath } from './repositories.ts';
import { FakeGitHub, rawRepository, TOKEN } from './test-fixtures.ts';

const LIST =
  '/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=pushed&direction=desc&per_page=100';

function setup(): { github: FakeGitHub; client: GitHubClient } {
  const github = new FakeGitHub();
  return { github, client: new GitHubClient({ token: TOKEN, fetch: github.fetch }) };
}

const nextPage = (page: number): Record<string, string> => ({
  link: `<https://api.github.com/user/repos?page=${String(page)}>; rel="next"`,
});

describe('repositoryPath', () => {
  it('builds the API path of a repository', () => {
    expect(repositoryPath('octo-org/widgets')).toBe('/repos/octo-org/widgets');
  });
});

describe('listAccessibleRepositories', () => {
  it('lists public and private repositories of every affiliation, most recently pushed first', async () => {
    const { github, client } = setup();
    github.on(LIST, {
      body: [
        rawRepository('octo-org/secret', { private: true }),
        rawRepository('octocat/hello', { private: false }),
        rawRepository('other-org/shared'),
      ],
    });

    expect(await listAccessibleRepositories(client)).toEqual({
      repositories: [
        { fullName: 'octo-org/secret', private: true },
        { fullName: 'octocat/hello', private: false },
        { fullName: 'other-org/shared', private: false },
      ],
      complete: true,
    });
    expect(github.paths).toEqual([LIST]);
  });

  it('leaves out archived and disabled repositories, and one listed twice', async () => {
    const { github, client } = setup();
    github.on(LIST, {
      body: [
        rawRepository('o/kept'),
        rawRepository('o/archived', { archived: true }),
        rawRepository('o/disabled', { disabled: true }),
      ],
      headers: nextPage(2),
    });
    github.on('/user/repos?page=2', { body: [rawRepository('O/Kept'), rawRepository('o/next')] });

    const result = await listAccessibleRepositories(client);

    expect(result.repositories.map((repository) => repository.fullName)).toEqual([
      'o/kept',
      'o/next',
    ]);
    expect(result.complete).toBe(true);
  });

  it('keeps the pages read when a later one fails, and says the list is incomplete', async () => {
    const { github, client } = setup();
    github.on(LIST, { body: [rawRepository('o/first')], headers: nextPage(2) });
    github.on('/user/repos?page=2', { status: 502, body: { message: 'Bad Gateway' } });

    expect(await listAccessibleRepositories(client)).toEqual({
      repositories: [{ fullName: 'o/first', private: false }],
      complete: false,
    });
  });

  it('throws when the first page fails', async () => {
    const { github, client } = setup();
    github.on(LIST, { status: 500, body: { message: 'Server Error' } });

    await expect(listAccessibleRepositories(client)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('lookUpRepository', () => {
  it('returns the repository under the name GitHub gives it', async () => {
    const { github, client } = setup();
    github.on('/repos/octo-org/widgets', { body: rawRepository('Octo-Org/Widgets') });

    expect((await lookUpRepository(client, 'octo-org/widgets')).fullName).toBe('Octo-Org/Widgets');
  });

  it('throws a NotFoundError for a repository the token cannot read', async () => {
    const { client } = setup();

    await expect(lookUpRepository(client, 'octo-org/secret')).rejects.toBeInstanceOf(NotFoundError);
  });
});
