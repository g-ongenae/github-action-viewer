import { describe, expect, it } from 'vitest';
import { createWatchListApi, type Fetch } from './watch-list-api.ts';

/** A `fetch` that records the requests and answers them all with `answer`. */
function fake(answer: () => Response | Promise<Response>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return answer();
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createWatchListApi', () => {
  it('calls the routes of the server, with the repository in the path', async () => {
    const { fetch, calls } = fake(() => json({}));
    const api = createWatchListApi(fetch);

    await api.catalogue();
    await api.add('Octo-Org/my.widgets_2');
    await api.remove('Octo-Org/my.widgets_2');

    expect(calls).toEqual([
      'GET /api/repositories',
      'PUT /api/maintained-repositories/Octo-Org/my.widgets_2',
      'DELETE /api/maintained-repositories/Octo-Org/my.widgets_2',
    ]);
  });

  it('returns what the server answered', async () => {
    const change = { repository: 'o/r', changed: true, maintainedRepositories: ['o/r'] };
    const api = createWatchListApi(fake(() => json(change)).fetch);

    expect(await api.add('o/r')).toEqual({ ok: true, value: change });
  });

  it('returns the message of an error answer', async () => {
    const api = createWatchListApi(fake(() => json({ error: 'o/r was not found.' }, 404)).fetch);

    expect(await api.add('o/r')).toEqual({ ok: false, message: 'o/r was not found.' });
  });

  it('describes an error without a message by its status', async () => {
    const plain = createWatchListApi(
      fake(() => new Response('Forbidden\n', { status: 403 })).fetch,
    );
    const empty = createWatchListApi(fake(() => json({ error: '' }, 500)).fetch);
    const notJson = createWatchListApi(fake(() => new Response('<html>', { status: 200 })).fetch);

    expect(await plain.remove('o/r')).toEqual({
      ok: false,
      message: 'The viewer’s server refused the request (HTTP 403).',
    });
    expect(await empty.catalogue()).toMatchObject({ ok: false });
    expect(await notJson.catalogue()).toMatchObject({ ok: false });
  });

  it('says so when the server cannot be reached', async () => {
    const api = createWatchListApi(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await api.catalogue()).toEqual({
      ok: false,
      message: 'Cannot reach the viewer’s server.',
    });
  });
});
