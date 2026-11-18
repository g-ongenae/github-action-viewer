// The row of status chips above the repositories. Each chip toggles one status and says how many
// lines have it; with none pressed every line shows. The choice is kept in the page's address.

import { element, setAttribute, setText } from './dom.ts';
import {
  LINE_STATUSES,
  readFilter,
  STATUS_PRESENTATION,
  writeFilter,
  type LineStatus,
} from './filter.ts';
import { stateIcon } from './icons.ts';

interface Chip {
  readonly button: HTMLButtonElement;
  readonly count: HTMLElement;
}

export class FilterBar {
  readonly #container: HTMLElement;
  readonly #chips = new Map<LineStatus, Chip>();
  readonly #clear: HTMLButtonElement;
  readonly #window: Window | null;
  readonly #onChange: () => void;
  #selected: ReadonlySet<LineStatus>;

  constructor(document: Document, onChange: () => void) {
    const container = document.getElementById('filters');
    if (container === null) {
      throw new Error('The page has no #filters element.');
    }
    this.#container = container;
    this.#window = document.defaultView;
    this.#onChange = onChange;
    this.#selected = readFilter(this.#window?.location.search ?? '');

    for (const status of LINE_STATUSES) {
      const presentation = STATUS_PRESENTATION[status];
      const button = element('button', `filter tone-${presentation.tone}`);
      button.type = 'button';
      button.title = presentation.description;
      const label = element('span', 'filter-label');
      label.textContent = presentation.label;
      const count = element('span', 'filter-count');
      button.append(stateIcon(presentation.icon), label, count);
      button.addEventListener('click', () => {
        const selected = new Set(this.#selected);
        if (!selected.delete(status)) {
          selected.add(status);
        }
        this.#select(selected);
      });
      this.#chips.set(status, { button, count });
    }
    this.#clear = element('button', 'button button-quiet filter-clear');
    this.#clear.type = 'button';
    this.#clear.textContent = 'Show all';
    this.#clear.addEventListener('click', () => {
      this.#chips.get(LINE_STATUSES[0])?.button.focus();
      this.#select(new Set());
    });
    container.replaceChildren(...[...this.#chips.values()].map((chip) => chip.button), this.#clear);
    this.#updateChips();
  }

  /** The statuses chosen; empty for every line. */
  get selected(): ReadonlySet<LineStatus> {
    return this.#selected;
  }

  /** Shows the number of lines of each status; null hides the chips (no lines to filter yet). */
  update(counts: Readonly<Record<LineStatus, number>> | null): void {
    this.#container.hidden = counts === null;
    for (const [status, chip] of this.#chips) {
      const count = counts?.[status] ?? 0;
      setText(chip.count, String(count));
      chip.button.classList.toggle('filter-is-empty', count === 0);
    }
  }

  #select(selected: ReadonlySet<LineStatus>): void {
    this.#selected = selected;
    this.#updateChips();
    const location = this.#window?.location;
    if (location !== undefined) {
      const url = `${location.pathname}${writeFilter(location.search, selected)}${location.hash}`;
      this.#window?.history.replaceState(this.#window.history.state, '', url);
    }
    this.#onChange();
  }

  #updateChips(): void {
    for (const [status, chip] of this.#chips) {
      setAttribute(chip.button, 'aria-pressed', String(this.#selected.has(status)));
    }
    this.#clear.hidden = this.#selected.size === 0;
  }
}
