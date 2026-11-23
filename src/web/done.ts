// Lines marked as done, like notifications on GitHub: hidden until something new happens on them
// (a new commit, a new or re-run workflow, or the newest commit's verdict changing, e.g. a run
// that finishes). Kept in the browser's local storage, so per browser, shared by its tabs.

import type { LineView, RepositoryView, Snapshot } from '../core/snapshot.ts';

/** Identifies a line across snapshots: `<repository>\n<line key>`. */
export function lineId(repository: RepositoryView, line: LineView): string {
  return `${repository.fullName}\n${line.key}`;
}

/** What a line showed when it was marked as done. */
export interface DoneMark {
  readonly sha: string;
  readonly verdict: string;
  /** Its runs, older commits' included, as `<id>.<attempt>`. */
  readonly runs: readonly string[];
  /** `generatedAt` of the snapshot the line was marked in. */
  readonly seenAt: string;
}

export function markOf(line: LineView, seenAt: string): DoneMark {
  return {
    sha: line.commit.sha,
    verdict: line.commitState,
    runs: line.runs.map(runKey),
    seenAt,
  };
}

/**
 * Whether `line` shows something `mark` did not: another commit or verdict, or a run (or an
 * attempt) it did not have. A run gone missing is not new: the collection only reads the latest
 * runs of a repository, so a run can drop out of it without anything happening.
 */
export function hasNewActivity(mark: DoneMark, line: LineView): boolean {
  if (line.commit.sha !== mark.sha || line.commitState !== mark.verdict) {
    return true;
  }
  const known = new Set(mark.runs);
  return line.runs.some((run) => !known.has(runKey(run)));
}

function runKey(run: LineView['runs'][number]): string {
  return `${String(run.id)}.${String(run.runAttempt)}`;
}

/** The repositories with only their lines not in `done`; those left without a line are dropped. */
export function withoutDone(
  repositories: readonly RepositoryView[],
  done: ReadonlySet<string>,
): readonly RepositoryView[] {
  if (done.size === 0) {
    return repositories;
  }
  return repositories.flatMap((repository) => {
    const lines = repository.lines.filter((line) => !done.has(lineId(repository, line)));
    return lines.length > 0 ? [{ ...repository, lines }] : [];
  });
}

const STORAGE_KEY = 'github-action-viewer.done';

/**
 * The marks of the lines marked as done, by line id. Every change re-reads the storage first, so
 * that tabs do not undo each other's changes. Storage may be missing or refuse access (private
 * browsing, blocked site data, full): the marks then only last as long as the page.
 */
export class DoneLines {
  #storage: Storage | null;
  #marks: Map<string, DoneMark>;

  constructor(storage: Storage | null) {
    this.#storage = storage;
    this.#marks = this.#read() ?? new Map<string, DoneMark>();
  }

  /** Ids of the lines of `repositories` marked as done since their last activity. */
  doneIn(repositories: readonly RepositoryView[]): ReadonlySet<string> {
    const done = new Set<string>();
    for (const repository of repositories) {
      for (const line of repository.lines) {
        const id = lineId(repository, line);
        const mark = this.#marks.get(id);
        if (mark !== undefined && !hasNewActivity(mark, line)) {
          done.add(id);
        }
      }
    }
    return done;
  }

  /** Marks `line` as done, as it shows in the snapshot generated at `seenAt`. */
  mark(repository: RepositoryView, line: LineView, seenAt: string): void {
    this.#change((marks) => marks.set(lineId(repository, line), markOf(line, seenAt)));
  }

  unmark(repository: RepositoryView, line: LineView): void {
    this.#change((marks) => marks.delete(lineId(repository, line)));
  }

  /**
   * Forgets the lines that saw new activity or left the page, so that they are not hidden again.
   * Only a snapshot newer than a mark can tell: another tab may have marked a line in a snapshot
   * this one has not received yet.
   */
  prune(snapshot: Snapshot): void {
    const lines = new Map(
      snapshot.repositories.flatMap((repository) =>
        repository.lines.map((line) => [lineId(repository, line), line] as const),
      ),
    );
    this.#change((marks) => {
      for (const [id, mark] of marks) {
        const line = lines.get(id);
        if (
          mark.seenAt < snapshot.generatedAt &&
          (line === undefined || hasNewActivity(mark, line))
        ) {
          marks.delete(id);
        }
      }
    });
  }

  /** Reads the marks again, after another tab changed them. */
  reload(): void {
    this.#marks = this.#read() ?? this.#marks;
  }

  /** Whether `event` (a `storage` event) is about these marks. */
  concerns(event: StorageEvent): boolean {
    return event.key === STORAGE_KEY || event.key === null;
  }

  #change(apply: (marks: Map<string, DoneMark>) => void): void {
    this.reload();
    const before = JSON.stringify([...this.#marks]);
    apply(this.#marks);
    if (JSON.stringify([...this.#marks]) !== before) {
      this.#write();
    }
  }

  /** The stored marks; null when the storage cannot be read. */
  #read(): Map<string, DoneMark> | null {
    if (this.#storage === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(this.#storage.getItem(STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return new Map();
      }
      return new Map(
        Object.entries(parsed).filter((entry): entry is [string, DoneMark] => isMark(entry[1])),
      );
    } catch {
      return null;
    }
  }

  #write(): void {
    try {
      if (this.#marks.size === 0) {
        this.#storage?.removeItem(STORAGE_KEY);
      } else {
        this.#storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#marks)));
      }
    } catch {
      // Full or refused: keep the marks in memory from now on, rather than reading back what the
      // storage did not take.
      this.#storage = null;
    }
  }
}

function isMark(value: unknown): value is DoneMark {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { sha, verdict, runs, seenAt } = value as Record<string, unknown>;
  return (
    typeof sha === 'string' &&
    typeof verdict === 'string' &&
    typeof seenAt === 'string' &&
    Array.isArray(runs) &&
    runs.every((run) => typeof run === 'string')
  );
}

/** The page's local storage, or null where the browser refuses it. */
export function localStorageOf(window: Window | null): Storage | null {
  try {
    return window?.localStorage ?? null;
  } catch {
    return null;
  }
}
