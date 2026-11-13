import { describe, expect, it } from 'vitest';
import { describeChanges, summarise, summaryParts, tabState } from './summary.ts';
import { lineIn, lineView, prLine, repositoryView, runView, snapshot } from './test-fixtures.ts';

const busy = snapshot([
  repositoryView('octo-org/widgets', [
    lineIn('in_progress'),
    prLine(1, { runs: [runView({ state: 'failure' }), runView({ id: 2, state: 'in_progress' })] }),
    prLine(2, { runs: [runView({ state: 'waiting' })] }),
  ]),
  repositoryView('octo-org/gadgets', [lineIn('timed_out'), lineIn('success', { key: 'branch:x' })]),
]);

describe('summarise', () => {
  it('counts running, failed and waiting lines', () => {
    expect(summarise(busy)).toEqual({ running: 2, failed: 2, waiting: 1 });
  });

  it('counts a wait for approval that is only left on an older commit', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'success' }),
        runView({ id: 2, state: 'waiting', superseded: true, headSha: 'old' }),
      ],
    });
    expect(line).toMatchObject({ state: 'waiting', commitState: 'success', active: true });
    const summary = summarise(snapshot([repositoryView('o/r', [line])]));
    expect(summary).toEqual({ running: 0, failed: 0, waiting: 1 });
    expect(summaryParts(summary)).toEqual([{ text: '1 waiting', tone: 'attention' }]);
    expect(tabState(summary, 'live').title).toBe('1 waiting · My GitHub Actions');
  });

  it('counts runs still active on an older commit, once per line', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'failure' }),
        runView({ id: 2, state: 'in_progress', superseded: true, headSha: 'old' }),
        runView({ id: 3, state: 'queued', superseded: true, headSha: 'older' }),
      ],
    });
    expect(summarise(snapshot([repositoryView('o/r', [line])]))).toEqual({
      running: 1,
      failed: 1,
      waiting: 0,
    });
  });

  it('counts nothing without a snapshot', () => {
    expect(summarise(null)).toEqual({ running: 0, failed: 0, waiting: 0 });
  });
});

describe('summaryParts', () => {
  it('lists what is going on, with tones', () => {
    expect(summaryParts(summarise(busy))).toEqual([
      { text: '2 running', tone: 'active' },
      { text: '2 failed', tone: 'failure' },
      { text: '1 waiting', tone: 'attention' },
    ]);
  });

  it('says when nothing runs', () => {
    expect(summaryParts({ running: 0, failed: 0, waiting: 0 })).toEqual([
      { text: 'Nothing running', tone: 'muted' },
    ]);
  });
});

describe('tabState', () => {
  it('puts the counts in the title; failures win the favicon', () => {
    expect(tabState({ running: 3, failed: 1, waiting: 0 }, 'live')).toEqual({
      title: '3 running · 1 failed · My GitHub Actions',
      favicon: 'failed',
    });
    expect(tabState({ running: 3, failed: 0, waiting: 0 }, 'live').favicon).toBe('running');
  });

  it('is quiet only when nothing runs, waits or failed', () => {
    expect(tabState({ running: 0, failed: 0, waiting: 0 }, 'live')).toEqual({
      title: 'My GitHub Actions',
      favicon: 'quiet',
    });
  });

  it('shows a wait like the summary does', () => {
    expect(tabState({ running: 0, failed: 0, waiting: 2 }, 'live')).toEqual({
      title: '2 waiting · My GitHub Actions',
      favicon: 'running',
    });
  });

  it('says when the connection is lost', () => {
    expect(tabState({ running: 3, failed: 1, waiting: 0 }, 'disconnected')).toEqual({
      title: 'Disconnected · My GitHub Actions',
      favicon: 'offline',
    });
  });
});

describe('describeChanges', () => {
  const at = (line: ReturnType<typeof lineView>) =>
    snapshot([repositoryView('octo-org/widgets', [line])]);

  it('announces nothing for the first snapshot', () => {
    expect(describeChanges(null, busy)).toBe('');
  });

  it('announces a line that finished', () => {
    expect(describeChanges(at(lineIn('in_progress')), at(lineIn('failure')))).toBe(
      'octo-org/widgets main failed.',
    );
  });

  it('announces the first failure of a line still running', () => {
    const running = lineView({
      runs: [runView({ state: 'in_progress' }), runView({ id: 2, state: 'in_progress' })],
    });
    const failing = lineView({
      runs: [runView({ state: 'in_progress' }), runView({ id: 2, state: 'failure' })],
    });
    expect(describeChanges(at(running), at(failing))).toBe('octo-org/widgets main: 1 failed.');
  });

  it('stays silent when nothing finished', () => {
    expect(describeChanges(at(lineIn('in_progress')), at(lineIn('in_progress')))).toBe('');
    expect(describeChanges(at(lineIn('success')), at(lineIn('failure')))).toBe('');
  });

  it('summarises many changes', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const before = snapshot([
      repositoryView(
        'o/r',
        keys.map((key) => lineIn('in_progress', { key, label: key })),
      ),
    ]);
    const after = snapshot([
      repositoryView(
        'o/r',
        keys.map((key) => lineIn('success', { key, label: key })),
      ),
    ]);
    expect(describeChanges(before, after)).toBe(
      'o/r a passed. o/r b passed. o/r c passed. And 2 more.',
    );
  });
});
