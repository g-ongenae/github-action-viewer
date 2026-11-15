import { describe, expect, it } from 'vitest';
import { isRepositoryName } from '../core/repository-name.ts';
import { WatchListError } from '../server/watch-list-editor.ts';
import { demoMaintained, demoPayload } from './payload.ts';
import { DemoSource } from './source.ts';
import { DEMO_CATALOGUE, DemoWatchList } from './watch-list.ts';

const START = Date.parse('2026-11-13T12:00:00Z');

describe('DemoWatchList', () => {
  it('offers made-up repositories, public and private', async () => {
    const { repositories, complete } = await new DemoWatchList([], () => undefined).catalogue();

    expect(complete).toBe(true);
    expect(repositories).toBe(DEMO_CATALOGUE);
    expect(repositories.every((repository) => isRepositoryName(repository.fullName))).toBe(true);
    expect(new Set(repositories.map((repository) => repository.private)).size).toBe(2);
  });

  it('adds and removes in memory, telling when the list changed', async () => {
    let changes = 0;
    const list = new DemoWatchList(['acme-labs/web-console'], () => (changes += 1));

    expect(await list.add('ACME-LABS/billing-service')).toEqual({
      repository: 'acme-labs/billing-service',
      changed: true,
      maintainedRepositories: ['acme-labs/web-console', 'acme-labs/billing-service'],
    });
    expect(await list.add('acme-labs/billing-service')).toMatchObject({ changed: false });
    // A public repository of someone else: not offered, but found by name.
    expect(await list.add('open-tools/yaml-lint')).toMatchObject({ changed: true });
    expect(await list.remove('Acme-Labs/Web-Console')).toMatchObject({
      changed: true,
      maintainedRepositories: ['acme-labs/billing-service', 'open-tools/yaml-lint'],
    });
    expect(await list.remove('acme-labs/web-console')).toMatchObject({ changed: false });
    expect(changes).toBe(3);
    expect(list.maintained).toEqual(['acme-labs/billing-service', 'open-tools/yaml-lint']);
  });

  it('refuses what its made-up GitHub does not know, like the real one', async () => {
    const list = new DemoWatchList([], () => undefined);

    await expect(list.add('nobody/nothing')).rejects.toMatchObject({
      status: 404,
      message: 'nobody/nothing was not found on GitHub, or the token cannot read it.',
    });
    await expect(list.add('not a name')).rejects.toBeInstanceOf(WatchListError);
    await expect(list.remove('')).rejects.toMatchObject({ status: 400 });
  });
});

describe('the demo with an edited watch list', () => {
  const namesOf = (maintained: readonly string[], variant: 'full' | 'empty' = 'full'): string[] =>
    demoPayload(variant, START, START, 0, {
      maintained,
      editing: 'on',
    }).snapshot?.repositories.map((repository) => repository.fullName) ?? [];

  it('starts with the maintained repositories of its story', () => {
    expect(demoMaintained('full')).toEqual(['acme-labs/web-console', 'acme-labs/data-pipeline']);
    expect(demoMaintained('empty')).toEqual([]);
    const { config } = demoPayload('full', START, START, 0).status;
    expect(config.maintainedRepositories).toEqual(demoMaintained('full'));
    expect(config.editing).toBe('on');
  });

  it('shows an added repository, and drops a removed one unless it has another reason to stay', () => {
    const before = namesOf(demoMaintained('full'));
    expect(before).toContain('acme-labs/data-pipeline');

    const after = namesOf(['acme-labs/web-console', 'acme-labs/billing-service']);
    expect(after).toContain('acme-labs/billing-service');
    expect(after).not.toContain('acme-labs/data-pipeline');
    expect(after).toContain('demo-user/rocket-launcher');
    expect(namesOf(['open-tools/yaml-lint'], 'empty')).toEqual(['open-tools/yaml-lint']);
  });

  it('no longer calls stale a repository that was removed', () => {
    const { status } = demoPayload('full', START, START, 0, { maintained: [], editing: 'on' });
    expect(status.staleRepositories).toEqual([]);
  });

  it('publishes a change of the watch list at once', async () => {
    const source = new DemoSource('full', () => START);
    const seen: boolean[] = [];
    source.subscribe((changed) => seen.push(changed));

    await source.watchList.add('acme-labs/design-system');

    expect(seen).toEqual([true]);
    expect(source.payloadJson()).toContain('"acme-labs/design-system"');
    expect(new DemoSource('full', () => START, false).payloadJson()).toContain('"editing":"off"');
  });
});
