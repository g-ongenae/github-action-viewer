// Lines marked as done, like notifications on GitHub: hidden until something new happens on them
// (a new commit, a new or re-run workflow, or the newest commit's verdict changing, e.g. a run
// that finishes). Kept in the browser's local storage, so per browser, shared by its tabs.

import type { LineView, RepositoryView } from '../core/snapshot.ts';

/** Identifies a line across snapshots: `<repository>\n<line key>`. */
export function lineId(repository: RepositoryView, line: LineView): string {
  return `${repository.fullName}\n${line.key}`;
}

/** What the line was showing when marked as done; it comes back once this changes. */
export function lineMark(line: LineView): string {
  const runs = line.runs
    .filter((run) => !run.superseded)
    .map((run) => `${String(run.id)}.${String(run.runAttempt)}`)
    .sort();
  return [line.commit.sha, line.commitState, ...runs].join(' ');
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
 * The marks of the lines marked as done, by line id. Storage may be missing or refuse access
 * (private browsing, blocked site data): the marks then only last as long as the page.
 */
export class DoneLines {
  readonly #storage: Storage | null;
  #marks: Map<string, string>;

  constructor(storage: Storage | null) {
    this.#storage = storage;
    this.#marks = this.#read();
  }

  /** Ids of the lines of `repositories` marked as done since their last change. */
  doneIn(repositories: readonly RepositoryView[]): ReadonlySet<string> {
    const done = new Set<string>();
    for (const repository of repositories) {
      for (const line of repository.lines) {
        const id = lineId(repository, line);
        if (this.#marks.get(id) === lineMark(line)) {
          done.add(id);
        }
      }
    }
    return done;
  }

  mark(repository: RepositoryView, line: LineView): void {
    this.#marks.set(lineId(repository, line), lineMark(line));
    this.#write();
  }

  unmark(repository: RepositoryView, line: LineView): void {
    if (this.#marks.delete(lineId(repository, line))) {
      this.#write();
    }
  }

  /** Forgets the lines that changed or left the page: they will not be hidden again. */
  prune(repositories: readonly RepositoryView[]): void {
    const done = this.doneIn(repositories);
    const before = this.#marks.size;
    this.#marks = new Map([...this.#marks].filter(([id]) => done.has(id)));
    if (this.#marks.size !== before) {
      this.#write();
    }
  }

  /** Reads the marks again, after another tab changed them. */
  reload(): void {
    this.#marks = this.#read();
  }

  /** Whether `event` (a `storage` event) is about these marks. */
  concerns(event: StorageEvent): boolean {
    return event.key === STORAGE_KEY || event.key === null;
  }

  #read(): Map<string, string> {
    try {
      const parsed: unknown = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return new Map();
      }
      return new Map(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return new Map();
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
      // Storage full or refused: the marks still apply until the page is closed.
    }
  }
}

/** The page's local storage, or null where the browser refuses it. */
export function localStorageOf(window: Window | null): Storage | null {
  try {
    return window?.localStorage ?? null;
  } catch {
    return null;
  }
}
