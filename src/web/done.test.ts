import { describe, expect, it } from 'vitest';
import { DoneLines, lineId, lineMark, withoutDone } from './done.ts';
import {
  lineIn,
  lineView,
  MemoryStorage,
  prLine,
  repositoryView,
  runView,
} from './test-fixtures.ts';

const STORAGE_KEY = 'github-action-viewer.done';

describe('lineMark', () => {
  const line = lineView({ runs: [runView({ id: 1 }), runView({ id: 2 })] });

  it('stays while nothing new happens', () => {
    expect(lineMark(lineView({ runs: [runView({ id: 2 }), runView({ id: 1 })] }))).toBe(
      lineMark(line),
    );
    expect(lineMark({ ...line, updatedAt: '2026-11-13T12:30:00Z' })).toBe(lineMark(line));
    const olderCommitRunning = lineView({
      runs: [runView({ id: 1 }), runView({ id: 2 }), runView({ id: 3, superseded: true })],
    });
    expect(lineMark(olderCommitRunning)).toBe(lineMark(line));
  });

  it('changes with a new commit, a new run, a re-run or a new verdict', () => {
    const marks = [
      lineView({ ...line, commit: { ...line.commit, sha: 'b'.repeat(40) } }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2 }), runView({ id: 3 })] }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2, runAttempt: 2 })] }),
      lineView({ runs: [runView({ id: 1 }), runView({ id: 2, state: 'failure' })] }),
    ].map(lineMark);
    expect(new Set([lineMark(line), ...marks]).size).toBe(5);
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
  const repository = repositoryView('o/r', [lineIn('failure'), passed]);
  const id = lineId(repository, passed);

  it('remembers a line until it changes, in the storage', () => {
    const storage = new MemoryStorage();
    const done = new DoneLines(storage);
    done.mark(repository, passed);
    expect(done.doneIn([repository])).toEqual(new Set([id]));
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set([id]));

    const rerun = prLine(1, { runs: [runView({ runAttempt: 2 })] });
    expect(done.doneIn([repositoryView('o/r', [rerun])])).toEqual(new Set());

    done.unmark(repository, passed);
    expect(done.doneIn([repository])).toEqual(new Set());
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('forgets the lines that changed or left the page', () => {
    const storage = new MemoryStorage();
    const done = new DoneLines(storage);
    const other = repositoryView('o/other', [lineIn('success')]);
    done.mark(repository, passed);
    done.mark(repository, lineIn('failure'));
    done.mark(other, lineIn('success'));

    const failedAgain = lineView({ runs: [runView({ id: 9, state: 'failure' })] });
    done.prune([repositoryView('o/r', [failedAgain, passed])]);
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '')).toEqual({ [id]: lineMark(passed) });
    // The same line coming back as it was is not hidden again.
    expect(done.doneIn([repository, other])).toEqual(new Set([id]));
  });

  it('reads what another tab wrote', () => {
    const storage = new MemoryStorage();
    const done = new DoneLines(storage);
    new DoneLines(storage).mark(repository, passed);
    expect(done.doneIn([repository])).toEqual(new Set());
    done.reload();
    expect(done.doneIn([repository])).toEqual(new Set([id]));
  });

  it('starts empty from unreadable storage, and keeps marks in memory when it fails', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set());
    storage.setItem(STORAGE_KEY, JSON.stringify({ [id]: 3 }));
    expect(new DoneLines(storage).doneIn([repository])).toEqual(new Set());

    const failing = new MemoryStorage();
    failing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const done = new DoneLines(failing);
    done.mark(repository, passed);
    expect(done.doneIn([repository])).toEqual(new Set([id]));

    const memoryOnly = new DoneLines(null);
    memoryOnly.mark(repository, passed);
    expect(memoryOnly.doneIn([repository])).toEqual(new Set([id]));
  });
});
