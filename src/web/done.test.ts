import { describe, expect, it } from 'vitest';
import { DoneLines, hasNewActivity, lineId, markOf, withoutDone } from './done.ts';
import {
  iso,
  lineIn,
  lineView,
  MemoryStorage,
  prLine,
  repositoryView,
  runView,
  snapshot,
} from './test-fixtures.ts';

const STORAGE_KEY = 'github-action-viewer.done';

const storedIds = (storage: Storage): string[] =>
  Object.keys(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as object);

describe('hasNewActivity', () => {
  const line = lineView({ runs: [runView({ id: 1 }), runView({ id: 2 })] });
  const mark = markOf(line, iso(1));

  it('sees nothing new while runs only progress or drop out of the collection', () => {
    expect(hasNewActivity(mark, lineView({ runs: [runView({ id: 2 }), runView({ id: 1 })] }))).toBe(
      false,
    );
    expect(hasNewActivity(mark, { ...line, updatedAt: iso(0) })).toBe(false);
    expect(hasNewActivity(mark, lineView({ runs: [runView({ id: 2 })] }))).toBe(false);
  });

  it('sees a new commit, a new run, a re-run, a new verdict or a run on an older commit', () => {
    const changed = [
      lineView({ ...line, commit: { ...line.commit, sha: 'b'.repeat(40) } }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2 }), runView({ id: 3 })] }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2, runAttempt: 2 })] }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2, state: 'failure' })] }),
      lineView({
        runs: [
          runView({ id: 1 }),
          runView({ id: 2 }),
          runView({ id: 0, state: 'waiting', superseded: true, headSha: 'old', runAttempt: 2 }),
        ],
      }),
    ];
    expect(changed.map((candidate) => hasNewActivity(mark, candidate))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('withoutDone', () => {
  const widgets = repositoryView('o/widgets', [lineIn('success'), prLine(1)]);
  const gadgets = repositoryView('o/gadgets', [lineIn('failure')]);

  it('drops the lines marked as done, and the repositories left without a line', () => {
    const done = new Set([lineId(widgets, prLine(1)), lineId(gadgets, lineIn('failure'))]);
    expect(withoutDone([widgets, gadgets], done)).toEqual([
      { ...widgets, lines: [lineIn('success')] },
    ]);
    expect(withoutDone([widgets, gadgets], new Set())).toEqual([widgets, gadgets]);
  });
});

describe('DoneLines', () => {
  const passed = prLine(1);
  const failed = lineIn('failure');
  const repository = repositoryView('o/r', [failed, passed]);
  const id = lineId(repository, passed);

  it('remembers a line until something new happens on it, in the storage', () => {
    const storage = new MemoryStorage();
    const done = new DoneLines(storage);
    done.mark(repository, passed, iso(1));
    expect(done.doneIn([repository])).toEqual(new Set([id]));
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set([id]));

    const rerun = prLine(1, { runs: [runView({ runAttempt: 2 })] });
    expect(done.doneIn([repositoryView('o/r', [rerun])])).toEqual(new Set());

    done.unmark(repository, passed);
    expect(done.doneIn([repository])).toEqual(new Set());
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('forgets, from a newer snapshot, the lines that saw new activity or left the page', () => {
    const storage = new MemoryStorage();
    const done = new DoneLines(storage);
    const other = repositoryView('o/other', [lineIn('success')]);
    done.mark(repository, passed, iso(2));
    done.mark(repository, failed, iso(2));
    done.mark(other, lineIn('success'), iso(2));

    const failedAgain = lineView({ runs: [runView({ id: 9, state: 'failure' })] });
    const changed = [repositoryView('o/r', [failedAgain, passed])];
    done.prune(snapshot(changed, { generatedAt: iso(2) }));
    expect(storedIds(storage)).toHaveLength(3);

    done.prune(snapshot(changed, { generatedAt: iso(1) }));
    expect(storedIds(storage)).toEqual([id]);
    // The same line coming back as it was is not hidden again.
    expect(done.doneIn([repository, other])).toEqual(new Set([id]));
  });

  it('keeps what other tabs change, even from a snapshot this one has not received', () => {
    const storage = new MemoryStorage();
    const tab = new DoneLines(storage);
    const otherTab = new DoneLines(storage);
    tab.mark(repository, passed, iso(1));
    otherTab.mark(repository, failed, iso(1));
    expect(tab.doneIn([repository])).toEqual(new Set([id]));
    tab.reload();
    expect(tab.doneIn([repository]).size).toBe(2);

    // The other tab marked the re-run, which this tab has not seen yet: it does not prune it.
    const rerun = prLine(1, { runs: [runView({ runAttempt: 2 })] });
    otherTab.mark(repositoryView('o/r', [rerun]), rerun, iso(0.5));
    tab.prune(snapshot([repository], { generatedAt: iso(1) }));
    expect(otherTab.doneIn([repositoryView('o/r', [rerun])])).toEqual(new Set([id]));
  });

  it('starts empty from unreadable storage, and keeps marks in memory when it fails', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set());
    storage.setItem(STORAGE_KEY, JSON.stringify({ [id]: { sha: 3 } }));
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set());

    const failing = new MemoryStorage();
    failing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const done = new DoneLines(failing);
    done.mark(repository, passed, iso(1));
    done.mark(repository, failed, iso(1));
    expect(done.doneIn([repository]).size).toBe(2);

    const memoryOnly = new DoneLines(null);
    memoryOnly.mark(repository, passed, iso(1));
    expect(memoryOnly.doneIn([repository])).toEqual(new Set([id]));
  });
});
