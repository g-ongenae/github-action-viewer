// The row of status chips above the repositories. Each chip toggles one status and says how many
// lines have it; with none pressed every line shows. The choice is kept in the page's address.
// The “Done” chip at the end shows the lines marked as done, which are otherwise hidden.

import { element, setAttribute, setText } from './dom.ts';
import {
  LINE_STATUSES,
  readFilter,
  STATUS_PRESENTATION,
  writeFilter,
  type LineStatus,
} from './filter.ts';
import { checkIcon, stateIcon } from './icons.ts';

interface Chip {
  readonly button: HTMLButtonElement;
  readonly count: HTMLElement;
}

export class FilterBar {
  readonly #container: HTMLElement;
  readonly #chips = new Map<LineStatus, Chip>();
  readonly #clear: HTMLButtonElement;
  readonly #done: Chip;
  readonly #window: Window | null;
  readonly #onChange: () => void;
  #selected: ReadonlySet<LineStatus>;
  #showDone = false;

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
    this.#done = doneChip();
    this.#done.button.addEventListener('click', () => {
      this.#showDone = !this.#showDone;
      this.#updateChips();
      this.#onChange();
    });
    container.replaceChildren(
      ...[...this.#chips.values()].map((chip) => chip.button),
      this.#clear,
      this.#done.button,
    );
    this.#updateChips();
  }

  /** The statuses chosen; empty for every line. */
  get selected(): ReadonlySet<LineStatus> {
    return this.#selected;
  }

  /** Whether the lines marked as done show too. */
  get showDone(): boolean {
    return this.#showDone;
  }

  /**
   * Shows the number of lines of each status, and of lines marked as done; null hides the chips
   * (no lines to filter yet). The “Done” chip only shows while a line is done.
   */
  update(counts: Readonly<Record<LineStatus, number>> | null, done: number): void {
    this.#container.hidden = counts === null;
    for (const [status, chip] of this.#chips) {
      const count = counts?.[status] ?? 0;
      setText(chip.count, String(count));
      chip.button.classList.toggle('filter-is-empty', count === 0);
    }
    setText(this.#done.count, String(done));
    this.#done.button.hidden = done === 0;
    if (done === 0 && this.#showDone) {
      this.#showDone = false;
      this.#updateChips();
    }
  }

  /** Focuses the first pressed chip, or the first chip; does nothing while the chips are hidden. */
  takeFocus(): void {
    const first = LINE_STATUSES.find((status) => this.#selected.has(status)) ?? LINE_STATUSES[0];
    if (!this.#container.hidden) {
      this.#chips.get(first)?.button.focus({ preventScroll: true });
    }
  }

  /** Focuses the “Done” chip, where a line marked as done went; does nothing while it is hidden. */
  focusDone(): void {
    if (!this.#container.hidden && !this.#done.button.hidden) {
      this.#done.button.focus({ preventScroll: true });
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
    setAttribute(this.#done.button, 'aria-pressed', String(this.#showDone));
  }
}

function doneChip(): Chip {
  const button = element('button', 'filter filter-done tone-muted');
  button.type = 'button';
  button.title =
    'Also show the lines marked as done; each comes back by itself when something new happens on it';
  const label = element('span', 'filter-label');
  label.textContent = 'Done';
  const count = element('span', 'filter-count');
  button.append(checkIcon(), label, count);
  return { button, count };
}
