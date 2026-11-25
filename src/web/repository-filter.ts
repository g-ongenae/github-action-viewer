import type { RepositoryView } from '../core/snapshot.ts';
import { element, reconcile, setAttribute, setText } from './dom.ts';
import { plural } from './format.ts';
import { visibilityIcon } from './icons.ts';

const STORAGE_KEY = 'github-action-viewer.hidden-repositories';

interface RepositoryCount {
  readonly name: string;
  readonly count: number;
}

export class RepositoryFilter {
  readonly #list: HTMLElement;
  readonly #onToggle: (name: string, visible: boolean) => void;
  #storage: Storage | null;
  #hidden = new Set<string>();
  #renderedHidden: ReadonlySet<string> | null = null;
  #repositories: readonly RepositoryView[] | null = null;
  #counts: readonly RepositoryCount[] = [];

  constructor(
    document: Document,
    storage: Storage | null,
    onToggle: (name: string, visible: boolean) => void,
  ) {
    const list = document.getElementById('repository-filter-list');
    if (list === null) {
      throw new Error('The page has no #repository-filter-list element.');
    }
    this.#list = list;
    this.#storage = storage;
    this.#onToggle = onToggle;
    this.reload();
  }

  visible(repositories: readonly RepositoryView[]): readonly RepositoryView[] {
    return this.#hidden.size === 0
      ? repositories
      : repositories.filter(({ fullName }) => !this.#hidden.has(fullName.toLowerCase()));
  }

  concerns(event: StorageEvent): boolean {
    return event.key === STORAGE_KEY || event.key === null;
  }

  reload(): void {
    if (this.#storage !== null) {
      try {
        const saved: unknown = JSON.parse(this.#storage.getItem(STORAGE_KEY) ?? '[]');
        this.#hidden = new Set(
          Array.isArray(saved)
            ? saved
                .filter((name): name is string => typeof name === 'string')
                .map((name) => name.toLowerCase())
            : [],
        );
      } catch {
        // Keep the current preference when storage cannot be read.
      }
    }
  }

  update(repositories: readonly RepositoryView[]): void {
    if (repositories !== this.#repositories) {
      this.#repositories = repositories;
      this.#counts = repositories
        .map(({ fullName, lines }) => ({
          name: fullName,
          count: new Set(lines.flatMap(({ runs }) => runs.map(({ id }) => id))).size,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else if (this.#hidden === this.#renderedHidden) {
      return;
    }
    this.#renderedHidden = this.#hidden;

    reconcile(
      this.#list,
      this.#counts,
      ({ name }) => name.toLowerCase(),
      () => this.#createRow(),
      (row, { name, count }) => {
        const button = row.querySelector('button');
        const label = row.querySelector('.repository-filter-name');
        const badge = row.querySelector('.filter-count');
        if (button === null || label === null || badge === null) {
          return;
        }
        const visible = !this.#hidden.has(name.toLowerCase());
        setText(label, name);
        setText(badge, String(count));
        setAttribute(
          button,
          'aria-label',
          `Show activity for ${name}, ${plural(count, 'workflow run')}`,
        );
        setAttribute(button, 'aria-pressed', String(visible));
        setAttribute(button, 'title', `${visible ? 'Hide' : 'Show'} ${name}`);
      },
    );
  }

  #createRow(): HTMLElement {
    const row = element('li');
    const button = element('button', 'repository-visibility');
    button.type = 'button';
    const name = element('span', 'repository-filter-name');
    const count = element('span', 'filter-count');
    button.append(name, visibilityIcon(), count);
    button.addEventListener('click', () => {
      this.#toggle(name.textContent, button.getAttribute('aria-pressed') === 'true');
    });
    row.append(button);
    return row;
  }

  #toggle(name: string, wasVisible: boolean): void {
    this.reload();
    const key = name.toLowerCase();
    const hidden = new Set(this.#hidden);
    if (wasVisible) {
      hidden.add(key);
    } else {
      hidden.delete(key);
    }
    this.#hidden = hidden;
    try {
      this.#storage?.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
    } catch {
      this.#storage = null;
    }
    this.#onToggle(name, !wasVisible);
  }
}
