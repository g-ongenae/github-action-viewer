// The "Add a repository" dialog: a field to find a repository among those GitHub lists for the
// reader, or to name any other one, and the list of the repositories added so far, each with its
// "Remove" button. Changes go to the server, which writes them to the configuration file; the
// page then receives them like any other change.
//
// Like the rest of the page it is built with DOM APIs only and updated in place, so that a new
// payload never moves the focus or clears what is being typed.

import type { WatchReason } from '../core/inputs.ts';
import { isRepositoryName, nameKey } from '../core/repository-name.ts';
import type { CatalogueRepository, ConfigStatus } from '../server/payload.ts';
import { element, reconcile, setAttribute, setClassName, setLink, setText } from './dom.ts';
import { normaliseQuery, suggest, type Suggestions } from './suggestions.ts';
import type { WatchListApi } from './watch-list-api.ts';

/** What the dialog needs from the page's state. */
export interface WatchListView {
  /** The configuration's status; null before the first payload. */
  readonly config: ConfigStatus | null;
  /** The repositories on the page, with why each is there. */
  readonly repositories: readonly {
    readonly fullName: string;
    readonly reasons: readonly WatchReason[];
  }[];
}

type Catalogue =
  | { readonly state: 'idle' | 'loading' }
  | {
      readonly state: 'ready';
      readonly repositories: readonly CatalogueRepository[];
      readonly complete: boolean;
    }
  | { readonly state: 'failed'; readonly message: string };

/** One row of the suggestions: a repository of the catalogue, or the name that was typed. */
interface Suggestion {
  readonly fullName: string;
  /** Null for the typed name: nothing is known about it before the server checks it. */
  readonly private: boolean | null;
}

const BY_NAME_HINT = 'Type a full name, as owner/name, to add any repository your token can read.';

export class RepositoryDialog {
  readonly #api: WatchListApi;
  readonly #opener: HTMLButtonElement;
  readonly #dialog: HTMLDialogElement;
  readonly #blocked: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #submit: HTMLButtonElement;
  readonly #message: HTMLElement;
  readonly #suggestions: HTMLUListElement;
  readonly #note: HTMLElement;
  readonly #maintained: HTMLUListElement;
  readonly #none: HTMLElement;

  #view: WatchListView = { config: null, repositories: [] };
  #catalogue: Catalogue = { state: 'idle' };
  /** Counts the loads of the catalogue, to ignore the answer of one that was superseded. */
  #load = 0;
  /** A change is on its way to the server: no other one starts meanwhile. */
  #busy = false;

  /** `opener` is the page's button that shows the dialog; the dialog itself is added to the body. */
  constructor(document: Document, opener: HTMLButtonElement, api: WatchListApi) {
    this.#api = api;
    this.#opener = opener;

    const dialog = element('dialog', 'repository-dialog');
    const form = element('form', 'dialog-body');
    form.noValidate = true;

    const header = element('header', 'dialog-header');
    const title = element('h2', 'dialog-title');
    title.id = 'repository-dialog-title';
    title.textContent = 'Add a repository';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = element('button', 'button button-quiet dialog-close');
    close.type = 'button';
    close.textContent = 'Close';
    header.append(title, close);

    const intro = element('p', 'dialog-intro');
    intro.textContent =
      'Watch the workflow runs of any repository your GitHub token can read, public or private, in any organisation or account.';
    const blocked = element('p', 'dialog-blocked');
    blocked.textContent =
      'The configuration file has problems (see the notice on the page). Fix them to add or remove repositories here.';

    const field = element('div', 'field');
    const label = element('label', 'field-label');
    label.textContent = 'Repository';
    const input = element('input', 'field-input');
    input.id = 'repository-dialog-input';
    label.htmlFor = input.id;
    input.type = 'text';
    input.placeholder = 'owner/name';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.autofocus = true;
    const submit = element('button', 'button button-primary');
    submit.type = 'submit';
    submit.textContent = 'Add';
    const row = element('div', 'field-row');
    row.append(input, submit);
    field.append(label, row);

    const message = element('p', 'dialog-message');
    message.setAttribute('role', 'status');
    message.hidden = true;

    const suggestions = element('ul', 'suggestions');
    suggestions.setAttribute('role', 'list');
    suggestions.setAttribute('aria-label', 'Repositories you can add');
    const note = element('p', 'dialog-note');

    const maintainedTitle = element('h3', 'dialog-subtitle');
    maintainedTitle.id = 'repository-dialog-added';
    maintainedTitle.textContent = 'Added repositories';
    const maintained = element('ul', 'maintained');
    maintained.setAttribute('role', 'list');
    maintained.setAttribute('aria-labelledby', maintainedTitle.id);
    const none = element('p', 'dialog-note');
    none.textContent =
      'None yet. Your own repositories and those where you have an open pull request are watched without being added.';

    form.append(
      header,
      intro,
      blocked,
      field,
      message,
      suggestions,
      note,
      maintainedTitle,
      maintained,
      none,
    );
    dialog.append(form);
    document.body.append(dialog);

    this.#dialog = dialog;
    this.#blocked = blocked;
    this.#input = input;
    this.#submit = submit;
    this.#message = message;
    this.#suggestions = suggestions;
    this.#note = note;
    this.#maintained = maintained;
    this.#none = none;

    opener.addEventListener('click', () => {
      this.open();
    });
    close.addEventListener('click', () => {
      dialog.close();
    });
    // A click on the backdrop lands on the dialog itself, which has no padding of its own.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    form.addEventListener('submit', (event) => {
      // Never submitted as a form (the page's CSP would block it anyway).
      event.preventDefault();
      this.#submitTyped();
    });
    input.addEventListener('input', () => {
      this.#say(null);
      this.#render();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && this.#focusSuggestion(0)) {
        event.preventDefault();
      }
    });
    suggestions.addEventListener('keydown', (event) => {
      this.#moveAmongSuggestions(event);
    });
    this.#render();
  }

  /** The page's state changed: shows or hides the opener, and refreshes an open dialog. */
  update(view: WatchListView): void {
    this.#view = view;
    this.#render();
  }

  /** Shows the dialog, empty, and asks the server which repositories to offer. */
  open(): void {
    if (this.#dialog.open || !this.#canOpen()) {
      return;
    }
    this.#input.value = '';
    this.#say(null);
    this.#render();
    this.#dialog.showModal();
    void this.#loadCatalogue();
  }

  #canOpen(): boolean {
    const editing = this.#view.config?.editing ?? 'off';
    return editing !== 'off';
  }

  #editable(): boolean {
    return this.#view.config?.editing === 'on';
  }

  async #loadCatalogue(): Promise<void> {
    if (!this.#editable()) {
      return;
    }
    this.#load += 1;
    const load = this.#load;
    // The previous list stays on screen while it is refreshed.
    if (this.#catalogue.state !== 'ready') {
      this.#catalogue = { state: 'loading' };
      this.#render();
    }
    const result = await this.#api.catalogue();
    if (load !== this.#load) {
      return;
    }
    this.#catalogue = result.ok
      ? { state: 'ready', ...result.value }
      : { state: 'failed', message: result.message };
    this.#render();
  }

  /** Enter in the field, or the "Add" button: the typed name, or the only match. */
  #submitTyped(): void {
    const offered = this.#offered();
    const typed = normaliseQuery(this.#input.value);
    if (offered.alreadyAdded !== null) {
      this.#say({ tone: 'info', text: `${offered.alreadyAdded} is already added.` });
    } else if (isRepositoryName(typed)) {
      void this.#add(typed);
    } else if (offered.matches.length === 1 && offered.matches[0] !== undefined) {
      void this.#add(offered.matches[0].fullName);
    } else {
      this.#say({
        tone: 'error',
        text:
          typed === ''
            ? 'Type the name of a repository, as owner/name, or pick one below.'
            : `“${typed}” is not a full repository name: type it as owner/name, or pick a repository below.`,
      });
    }
  }

  async #add(repository: string): Promise<void> {
    if (this.#busy || !this.#editable()) {
      return;
    }
    this.#setBusy(true);
    this.#say({ tone: 'info', text: `Adding ${repository}…` });
    const result = await this.#api.add(repository);
    this.#setBusy(false);
    if (!result.ok) {
      this.#say({ tone: 'error', text: result.message });
      return;
    }
    const { changed, repository: name, maintainedRepositories } = result.value;
    this.#adopt(maintainedRepositories);
    this.#input.value = '';
    this.#say({
      tone: 'success',
      text: changed
        ? `Added ${name}. It appears on the page in a moment, if it has workflow runs.`
        : `${name} was already added.`,
    });
    this.#render();
    this.#input.focus();
  }

  async #remove(repository: string): Promise<void> {
    if (this.#busy || !this.#editable()) {
      return;
    }
    this.#setBusy(true);
    this.#say({ tone: 'info', text: `Removing ${repository}…` });
    const result = await this.#api.remove(repository);
    this.#setBusy(false);
    if (!result.ok) {
      this.#say({ tone: 'error', text: result.message });
      return;
    }
    this.#adopt(result.value.maintainedRepositories);
    this.#say({ tone: 'success', text: `Removed ${repository}.${this.#stillShown(repository)}` });
    this.#render();
    // Its "Remove" button, which had the focus, is gone.
    this.#input.focus();
  }

  /** Why a repository that was just removed stays on the page, as a sentence; empty if it goes. */
  #stillShown(repository: string): string {
    const reasons =
      this.#view.repositories.find((shown) => nameKey(shown.fullName) === nameKey(repository))
        ?.reasons ?? [];
    if (reasons.includes('own')) {
      return ' It stays on the page because you own it.';
    }
    return reasons.includes('my_pull_request')
      ? ' It stays on the page while you have an open pull request there.'
      : '';
  }

  /** Takes the list the server answered with, ahead of the payload that carries it too. */
  #adopt(maintainedRepositories: readonly string[]): void {
    const { config } = this.#view;
    if (config !== null) {
      this.#view = { ...this.#view, config: { ...config, maintainedRepositories } };
    }
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#render();
  }

  #say(
    message: { readonly tone: 'info' | 'success' | 'error'; readonly text: string } | null,
  ): void {
    this.#message.hidden = message === null;
    setClassName(
      this.#message,
      message === null ? 'dialog-message' : `dialog-message message-${message.tone}`,
    );
    setText(this.#message, message?.text ?? '');
  }

  #offered(): Suggestions {
    return suggest(
      this.#input.value,
      this.#catalogue.state === 'ready' ? this.#catalogue.repositories : [],
      this.#view.config?.maintainedRepositories ?? [],
    );
  }

  #render(): void {
    const editing = this.#view.config?.editing ?? 'off';
    const editable = editing === 'on';
    this.#opener.hidden = editing === 'off';
    this.#blocked.hidden = editing !== 'blocked';
    this.#input.disabled = !editable;
    this.#submit.disabled = !editable;
    // While a change is under way the buttons stay focusable (disabling the focused one would
    // drop the focus) and only say that they are unavailable; the handlers ignore them.
    setAttribute(this.#submit, 'aria-disabled', this.#busy ? 'true' : null);

    const offered = this.#offered();
    const rows: Suggestion[] = editable
      ? [
          ...(offered.typed === null ? [] : [{ fullName: offered.typed, private: null }]),
          ...offered.matches,
        ]
      : [];
    this.#suggestions.hidden = rows.length === 0;
    reconcile(
      this.#suggestions,
      rows,
      (row) => `${row.private === null ? 'typed' : 'listed'}:${row.fullName}`,
      () => this.#createSuggestion(),
      (item, row) => {
        this.#updateSuggestion(item, row);
      },
    );

    const note = editable ? this.#noteFor(offered) : null;
    this.#note.hidden = note === null;
    setText(this.#note, note ?? '');

    const maintained = this.#view.config?.maintainedRepositories ?? [];
    this.#none.hidden = maintained.length > 0;
    this.#maintained.hidden = maintained.length === 0;
    reconcile(
      this.#maintained,
      maintained,
      (name) => nameKey(name),
      () => this.#createMaintained(),
      (item, name) => {
        const [link, remove] = item.children;
        if (link !== undefined && remove instanceof HTMLButtonElement) {
          setLink(link, `https://github.com/${name}`, name);
          remove.dataset.repository = name;
          remove.disabled = !editable;
          setAttribute(remove, 'aria-disabled', this.#busy ? 'true' : null);
          setAttribute(remove, 'aria-label', `Remove ${name}`);
        }
      },
    );
  }

  /** The line under the suggestions: what is going on with the list, or how to go further. */
  #noteFor(offered: Suggestions): string | null {
    const catalogue = this.#catalogue;
    if (offered.alreadyAdded !== null) {
      return `${offered.alreadyAdded} is already added.`;
    }
    switch (catalogue.state) {
      case 'idle':
        return null;
      case 'loading':
        return 'Loading your repositories…';
      case 'failed':
        return `${catalogue.message} ${BY_NAME_HINT}`;
      case 'ready':
        break;
    }
    if (offered.more > 0) {
      return `${String(offered.more)} more: keep typing to narrow the list.`;
    }
    if (offered.matches.length === 0 && offered.typed === null) {
      return this.#input.value.trim() === ''
        ? `GitHub lists no other repository for you. ${BY_NAME_HINT}`
        : `None of the repositories GitHub lists for you matches. ${BY_NAME_HINT}`;
    }
    if (!catalogue.complete) {
      return `This list is incomplete. ${BY_NAME_HINT}`;
    }
    return offered.typed === null
      ? null
      : 'A name that is not in your list is checked on GitHub when you add it.';
  }

  #createSuggestion(): HTMLElement {
    const item = element('li', 'suggestion');
    const button = element('button', 'suggestion-button');
    button.type = 'button';
    button.append(element('bdi', 'suggestion-name'), element('span', 'suggestion-kind'));
    button.addEventListener('click', () => {
      const { repository } = button.dataset;
      if (repository !== undefined) {
        void this.#add(repository);
      }
    });
    item.append(button);
    return item;
  }

  #updateSuggestion(item: HTMLElement, row: Suggestion): void {
    const button = item.firstElementChild;
    const [name, kind] = button?.children ?? [];
    if (!(button instanceof HTMLButtonElement) || name === undefined || kind === undefined) {
      return;
    }
    button.dataset.repository = row.fullName;
    setAttribute(button, 'aria-disabled', this.#busy ? 'true' : null);
    setText(name, row.fullName);
    setText(kind, row.private === null ? 'add by name' : row.private ? 'private' : 'public');
    setClassName(
      kind,
      row.private === true ? 'suggestion-kind suggestion-private' : 'suggestion-kind',
    );
  }

  #createMaintained(): HTMLElement {
    const item = element('li', 'maintained-item');
    const remove = element('button', 'button button-quiet');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const { repository } = remove.dataset;
      if (repository !== undefined) {
        void this.#remove(repository);
      }
    });
    item.append(element('bdi', 'maintained-name'), remove);
    return item;
  }

  #suggestionButtons(): HTMLButtonElement[] {
    return [...this.#suggestions.querySelectorAll<HTMLButtonElement>('.suggestion-button')];
  }

  #focusSuggestion(index: number): boolean {
    const button = this.#suggestionButtons()[index];
    button?.focus();
    return button !== undefined;
  }

  /** Arrow keys walk the suggestions; up from the first one goes back to the field. */
  #moveAmongSuggestions(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const buttons = this.#suggestionButtons();
    const index = buttons.findIndex((button) => button === event.target);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) {
      this.#input.focus();
    } else {
      buttons[Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
    }
  }
}
