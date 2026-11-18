import { describe, expect, it } from 'vitest';
import {
  countStatuses,
  describeFilter,
  filterRepositories,
  lineStatuses,
  matchesFilter,
  readFilter,
  writeFilter,
} from './filter.ts';
import { lineIn, lineView, prLine, repositoryView, runView } from './test-fixtures.ts';

describe('lineStatuses', () => {
  it.each([
    ['in_progress', ['running']],
    ['queued', ['running']],
    ['waiting', ['waiting']],
    ['action_required', ['waiting']],
    ['failure', ['failed']],
    ['timed_out', ['failed']],
    ['success', ['passed']],
    ['cancelled', ['other']],
    ['skipped', ['other']],
    ['neutral', ['other']],
    ['stale', ['other']],
    ['unknown', ['other']],
  ] as const)('puts a line whose run is %s under %j', (state, statuses) => {
    expect([...lineStatuses(lineIn(state))]).toEqual(statuses);
  });

  it('puts a line under every status it has', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'failure' }),
        runView({ id: 2, state: 'in_progress' }),
        runView({ id: 3, state: 'waiting', superseded: true, headSha: 'old' }),
      ],
    });
    expect([...lineStatuses(line)].sort()).toEqual(['failed', 'running', 'waiting']);
  });

  it('judges a line by its newest commit, and by anything still active on an older one', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'success' }),
        runView({ id: 2, state: 'queued', superseded: true, headSha: 'old' }),
      ],
    });
    expect([...lineStatuses(line)].sort()).toEqual(['passed', 'running']);
  });
});

describe('matchesFilter', () => {
  it('matches every line when nothing is chosen, and any chosen status otherwise', () => {
    const line = lineIn('failure');
    expect(matchesFilter(line, new Set())).toBe(true);
    expect(matchesFilter(line, new Set(['running', 'failed']))).toBe(true);
    expect(matchesFilter(line, new Set(['passed']))).toBe(false);
  });
});

describe('filterRepositories', () => {
  const repositories = [
    repositoryView('o/a', [
      lineIn('success'),
      prLine(1, { runs: [runView({ state: 'failure' })] }),
    ]),
    repositoryView('o/b', [lineIn('success')]),
  ];

  it('keeps the repositories as they are without a filter', () => {
    expect(filterRepositories(repositories, new Set())).toBe(repositories);
  });

  it('keeps matching lines and drops repositories left empty', () => {
    const shown = filterRepositories(repositories, new Set(['failed']));
    expect(shown.map((repository) => repository.fullName)).toEqual(['o/a']);
    expect(shown[0]?.lines.map((line) => line.key)).toEqual(['pr:1']);
  });
});

describe('countStatuses', () => {
  it('counts each line once under each of its statuses', () => {
    const running = prLine(1, {
      runs: [runView({ id: 1, state: 'failure' }), runView({ id: 2, state: 'in_progress' })],
    });
    expect(
      countStatuses([
        repositoryView('o/a', [lineIn('success'), running]),
        repositoryView('o/b', [lineIn('cancelled')]),
      ]),
    ).toEqual({ running: 1, failed: 1, waiting: 0, passed: 1, other: 1 });
  });
});

describe('describeFilter', () => {
  const repositories = [repositoryView('o/a', [lineIn('success'), lineIn('failure')])];

  it('says how many lines show', () => {
    expect(describeFilter(repositories, new Set())).toBe('Showing all 2 lines.');
    expect(describeFilter(repositories, new Set(['failed']))).toBe('Showing 1 of 2 lines.');
    expect(describeFilter(repositories, new Set(['waiting']))).toBe(
      'No line matches the filter; 2 lines hidden.',
    );
  });
});

describe('readFilter and writeFilter', () => {
  it('reads the statuses of the query, ignoring unknown ones', () => {
    expect([...readFilter('?status=waiting,failed,nope&x=1')]).toEqual(['failed', 'waiting']);
    expect([...readFilter('?status=passed&status=other')]).toEqual(['passed', 'other']);
    expect(readFilter('').size).toBe(0);
  });

  it('writes them in a stable order, keeping other parameters', () => {
    expect(writeFilter('?x=1', new Set(['waiting', 'failed']))).toBe('?x=1&status=failed,waiting');
    expect(writeFilter('?status=failed', new Set())).toBe('');
    expect(writeFilter('?status=failed&x=1', new Set())).toBe('?x=1');
  });
});
