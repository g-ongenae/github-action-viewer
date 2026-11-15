// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigStatus, RepositoryCatalogue, WatchListChange } from '../server/payload.ts';
import { RepositoryDialog, type WatchListView } from './repository-dialog.ts';
import { configStatus } from './test-fixtures.ts';
import type { ApiResult, WatchListApi } from './watch-list-api.ts';

const CATALOGUE: RepositoryCatalogue = {
  repositories: [
    { fullName: 'octocat/dotfiles', private: true },
    { fullName: 'octo-org/widgets', private: false },
    { fullName: 'octo-org/gadgets', private: true },
  ],
  complete: true,
};

/** An API answering from the test: each call waits until the test settles it. */
class FakeApi implements WatchListApi {
  readonly calls: string[] = [];
  readonly #pending: ((result: ApiResult<never>) => void)[] = [];

  catalogue(): Promise<ApiResult<RepositoryCatalogue>> {
    return this.#call('catalogue');
  }

  add(repository: string): Promise<ApiResult<WatchListChange>> {
    return this.#call(`add ${repository}`);
  }

  remove(repository: string): Promise<ApiResult<WatchListChange>> {
    return this.#call(`remove ${repository}`);
  }

  #call<T>(name: string): Promise<ApiResult<T>> {
    this.calls.push(name);
    return new Promise((resolve) => {
      this.#pending.push(resolve);
    });
  }

  /** Answers the oldest pending call, and lets the dialog react. */
  async answer(value: unknown): Promise<void> {
    this.#pending.shift()?.({ ok: true, value: value as never });
    await settle();
  }

  async fail(message: string): Promise<void> {
    this.#pending.shift()?.({ ok: false, message });
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

let api: FakeApi;
let dialog: RepositoryDialog;

/** The first element matching `selector`, which must be of class `type`. */
function find<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`No ${selector}`);
  }
  return found;
}
const $ = (selector: string): HTMLElement => find(selector, HTMLElement);
const button = (selector: string): HTMLButtonElement => find(selector, HTMLButtonElement);
const texts = (selector: string): string[] =>
  [...document.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent);
const opener = (): HTMLButtonElement => button('#add-repository');
const element = (): HTMLDialogElement => find('dialog', HTMLDialogElement);
const input = (): HTMLInputElement => find('.field-input', HTMLInputElement);
const message = (): HTMLElement => $('.dialog-message');
/** The line under the suggestions; null while it is hidden. */
const note = (): string | null => {
  const [first] = document.querySelectorAll<HTMLElement>('.dialog-note');
  return first === undefined || first.hidden ? null : first.textContent;
};
const suggestions = (): string[] => texts('.suggestion-name');
const maintained = (): string[] => texts('.maintained-name');

function view(config: Partial<ConfigStatus> = {}, shown: WatchListView['repositories'] = []): void {
  dialog.update({ config: configStatus(config), repositories: shown });
}

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(): void {
  $('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** Opens the dialog with the catalogue loaded. */
async function openLoaded(config: Partial<ConfigStatus> = {}): Promise<void> {
  view(config);
  opener().click();
  await api.answer(CATALOGUE);
}

const change = (repository: string, maintainedRepositories: string[], changed = true) => ({
  repository,
  changed,
  maintainedRepositories,
});

beforeEach(() => {
  document.body.innerHTML =
    '<button id="add-repository" type="button" hidden>Add repository</button>';
  api = new FakeApi();
  dialog = new RepositoryDialog(document, opener(), api);
});

describe('RepositoryDialog: opening', () => {
  it('offers to add repositories once the server says the page may', () => {
    expect(opener().hidden).toBe(true);
    view({ editing: 'on' });
    expect(opener().hidden).toBe(false);
    view({ editing: 'blocked' });
    expect(opener().hidden).toBe(false);
    view({ editing: 'off' });
    expect(opener().hidden).toBe(true);
    dialog.update({ config: null, repositories: [] });
    expect(opener().hidden).toBe(true);
  });

  it('stays closed when the page may not edit', () => {
    view({ editing: 'off' });
    dialog.open();
    expect(element().open).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('opens as a labelled dialog and loads the repositories to offer', async () => {
    view();
    opener().click();

    expect(element().open).toBe(true);
    expect($(`#${element().getAttribute('aria-labelledby') ?? ''}`).textContent).toBe(
      'Add a repository',
    );
    expect($(`label[for="${input().id}"]`).textContent).toBe('Repository');
    expect(api.calls).toEqual(['catalogue']);
    expect(note()).toBe('Loading your repositories…');
    expect(suggestions()).toEqual([]);

    await api.answer(CATALOGUE);
    expect(suggestions()).toEqual(['octocat/dotfiles', 'octo-org/widgets', 'octo-org/gadgets']);
    expect(texts('.suggestion-kind')).toEqual(['private', 'public', 'private']);
    expect(note()).toBeNull();
  });

  it('starts afresh each time it is opened, refreshing the list behind the one it has', async () => {
    await openLoaded();
    type('gad');
    $('.dialog-close').click();
    expect(element().open).toBe(false);

    opener().click();
    expect(input().value).toBe('');
    expect(suggestions()).toHaveLength(3);
    expect(note()).toBeNull();
    expect(api.calls).toEqual(['catalogue', 'catalogue']);

    await api.answer({ repositories: [{ fullName: 'o/new', private: false }], complete: true });
    expect(suggestions()).toEqual(['o/new']);
  });

  it('closes on a click on the backdrop, not on a click inside', async () => {
    await openLoaded();
    input().click();
    expect(element().open).toBe(true);
    element().click();
    expect(element().open).toBe(false);
  });

  it('explains why nothing can be changed while the configuration file has problems', () => {
    view({ editing: 'blocked', state: 'invalid', maintainedRepositories: ['o/kept'] });
    opener().click();

    expect(element().open).toBe(true);
    expect($('.dialog-blocked').hidden).toBe(false);
    expect(input().disabled).toBe(true);
    expect(button('.field-row button').disabled).toBe(true);
    expect(button('.maintained-item button').disabled).toBe(true);
    expect(maintained()).toEqual(['o/kept']);
    expect(api.calls).toEqual([]);

    view({ editing: 'on', maintainedRepositories: ['o/kept'] });
    expect($('.dialog-blocked').hidden).toBe(true);
    expect(input().disabled).toBe(false);
  });
});

describe('RepositoryDialog: finding a repository', () => {
  it('narrows the suggestions as the reader types', async () => {
    await openLoaded();
    type('octo-org');
    expect(suggestions()).toEqual(['octo-org/widgets', 'octo-org/gadgets']);
    type('GADG');
    expect(suggestions()).toEqual(['octo-org/gadgets']);
  });

  it('does not offer the repositories already added', async () => {
    await openLoaded({ maintainedRepositories: ['Octo-Org/Widgets'] });
    expect(suggestions()).toEqual(['octocat/dotfiles', 'octo-org/gadgets']);

    type('octo-org/widgets');
    expect(suggestions()).toEqual([]);
    expect(note()).toBe('octo-org/widgets is already added.');
  });

  it('offers a full name that is not in the list, to be checked on GitHub', async () => {
    await openLoaded();
    type('someone/public-thing');

    expect(suggestions()).toEqual(['someone/public-thing']);
    expect(texts('.suggestion-kind')).toEqual(['add by name']);
    expect(note()).toBe('A name that is not in your list is checked on GitHub when you add it.');
  });

  it('says how to go further when nothing matches', async () => {
    await openLoaded();
    type('zzz');
    expect(suggestions()).toEqual([]);
    expect(note()).toBe(
      'None of the repositories GitHub lists for you matches. Type a full name, as owner/name, to add any repository your token can read.',
    );
  });

  it('says how many suggestions are left out, and when the list is incomplete', async () => {
    view();
    opener().click();
    await api.answer({
      repositories: Array.from({ length: 11 }, (_, index) => ({
        fullName: `o/r${String(index)}`,
        private: false,
      })),
      complete: false,
    });

    expect(suggestions()).toHaveLength(8);
    expect(note()).toBe('3 more: keep typing to narrow the list.');
    type('r10');
    expect(note()).toBe(
      'This list is incomplete. Type a full name, as owner/name, to add any repository your token can read.',
    );
  });

  it('still takes a full name when the list could not be loaded', async () => {
    view();
    opener().click();
    await api.fail('Your repositories could not be listed: network error.');

    expect(note()).toBe(
      'Your repositories could not be listed: network error. Type a full name, as owner/name, to add any repository your token can read.',
    );
    type('o/r');
    expect(suggestions()).toEqual(['o/r']);
  });

  it('walks the suggestions with the arrow keys, and back to the field', async () => {
    await openLoaded();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.suggestion-button')];

    expect(press(input(), 'ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    press(buttons[0] as HTMLElement, 'ArrowDown');
    press(buttons[1] as HTMLElement, 'ArrowDown');
    press(buttons[2] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[2]);
    press(buttons[2] as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(buttons[1]);
    press(buttons[1] as HTMLElement, 'ArrowUp');
    press(buttons[0] as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(input());
  });
});

describe('RepositoryDialog: adding', () => {
  it('adds the suggestion that is clicked, and says what happens next', async () => {
    await openLoaded();
    type('widg');
    $('.suggestion-button').click();

    expect(api.calls).toEqual(['catalogue', 'add octo-org/widgets']);
    expect(message().textContent).toBe('Adding octo-org/widgets…');
    expect(message().getAttribute('role')).toBe('status');

    await api.answer(change('Octo-Org/Widgets', ['Octo-Org/Widgets']));
    expect(message().textContent).toBe(
      'Added Octo-Org/Widgets. It appears on the page in a moment, if it has workflow runs.',
    );
    expect(message().className).toContain('message-success');
    expect(maintained()).toEqual(['Octo-Org/Widgets']);
    expect($('.maintained-name a').getAttribute('href')).toBe(
      'https://github.com/Octo-Org/Widgets',
    );
    expect(input().value).toBe('');
    expect(suggestions()).toEqual(['octocat/dotfiles', 'octo-org/gadgets']);
    expect(document.activeElement).toBe(input());
  });

  it('adds the typed name on Enter, even one the list does not have', async () => {
    await openLoaded();
    type('  Someone/Public-Thing ');
    submit();

    expect(api.calls.at(-1)).toBe('add Someone/Public-Thing');
  });

  it('adds the repository a pasted GitHub address names', async () => {
    await openLoaded();
    type('https://github.com/someone/thing/actions');
    submit();

    expect(api.calls.at(-1)).toBe('add someone/thing');
  });

  it('adds the only match on Enter, and asks for more when there are several', async () => {
    await openLoaded();
    type('gadg');
    submit();
    expect(api.calls.at(-1)).toBe('add octo-org/gadgets');
    await api.answer(change('octo-org/gadgets', ['octo-org/gadgets']));

    type('octo');
    submit();
    expect(api.calls).toHaveLength(2);
    expect(message().textContent).toBe(
      '“octo” is not a full repository name: type it as owner/name, or pick a repository below.',
    );
    expect(message().className).toContain('message-error');

    type('');
    expect(message().hidden).toBe(true);
    submit();
    expect(message().textContent).toBe(
      'Type the name of a repository, as owner/name, or pick one below.',
    );
  });

  it('never submits the form', async () => {
    await openLoaded();
    const event = new Event('submit', { bubbles: true, cancelable: true });
    $('form').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('says so when the repository was already added', async () => {
    await openLoaded();
    type('o/renamed');
    submit();
    await api.answer(change('o/current', ['o/current'], false));
    expect(message().textContent).toBe('o/current was already added.');

    type('O/CURRENT');
    submit();
    expect(message().textContent).toBe('O/CURRENT is already added.');
    expect(api.calls).toHaveLength(2);
  });

  it('shows why the server refused, and keeps what was typed', async () => {
    await openLoaded();
    type('octo-org/secret');
    submit();
    await api.fail('octo-org/secret was not found on GitHub, or the token cannot read it.');

    expect(message().textContent).toBe(
      'octo-org/secret was not found on GitHub, or the token cannot read it.',
    );
    expect(message().className).toContain('message-error');
    expect(input().value).toBe('octo-org/secret');
    expect(maintained()).toEqual([]);
  });

  it('makes one change at a time, keeping the buttons focusable meanwhile', async () => {
    await openLoaded({ maintainedRepositories: ['o/kept'] });
    const [first, second] = document.querySelectorAll<HTMLButtonElement>('.suggestion-button');
    first?.click();

    expect(first?.getAttribute('aria-disabled')).toBe('true');
    expect(first?.disabled).toBe(false);
    second?.click();
    submit();
    button('.maintained-item button').click();
    expect(api.calls).toEqual(['catalogue', 'add octocat/dotfiles']);

    await api.answer(change('octocat/dotfiles', ['o/kept', 'octocat/dotfiles']));
    expect($('.suggestion-button').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('RepositoryDialog: the added repositories', () => {
  it('lists them, or says that there are none', () => {
    view();
    opener().click();
    expect($('.maintained').hidden).toBe(true);
    expect(texts('.dialog-note').at(-1)).toMatch(/^None yet\./);

    view({ maintainedRepositories: ['o/a', 'o/b'] });
    expect(maintained()).toEqual(['o/a', 'o/b']);
    expect($('.maintained').hidden).toBe(false);
    expect(
      [...document.querySelectorAll('.maintained-item button')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Remove o/a', 'Remove o/b']);
  });

  it('removes one, and offers it again', async () => {
    await openLoaded({ maintainedRepositories: ['o/a', 'octo-org/widgets'] });
    expect(suggestions()).not.toContain('octo-org/widgets');

    document.querySelectorAll<HTMLButtonElement>('.maintained-item button')[1]?.click();
    expect(api.calls.at(-1)).toBe('remove octo-org/widgets');
    await api.answer(change('octo-org/widgets', ['o/a']));

    expect(message().textContent).toBe('Removed octo-org/widgets.');
    expect(maintained()).toEqual(['o/a']);
    expect(suggestions()).toContain('octo-org/widgets');
    expect(document.activeElement).toBe(input());
  });

  it.each([
    [['own', 'maintained'], ' It stays on the page because you own it.'],
    [
      ['maintained', 'my_pull_request'],
      ' It stays on the page while you have an open pull request there.',
    ],
    [['maintained'], ''],
  ] as const)('says when a removed repository stays on the page (%j)', async (reasons, ending) => {
    dialog.update({
      config: configStatus({ maintainedRepositories: ['o/a'] }),
      repositories: [{ fullName: 'O/A', reasons }],
    });
    opener().click();
    await api.answer(CATALOGUE);

    button('.maintained-item button').click();
    await api.answer(change('o/a', []));

    expect(message().textContent).toBe(`Removed o/a.${ending}`);
  });

  it('shows why a removal failed', async () => {
    await openLoaded({ maintainedRepositories: ['o/a'] });
    button('.maintained-item button').click();
    await api.fail('The configuration file could not be written (EACCES).');

    expect(message().textContent).toBe('The configuration file could not be written (EACCES).');
    expect(maintained()).toEqual(['o/a']);
  });
});

describe('RepositoryDialog: updates from the server', () => {
  it('follows the list the server publishes, without touching what is being typed', async () => {
    await openLoaded();
    type('gadg');
    input().focus();
    const row = $('.suggestion');

    view({ maintainedRepositories: ['octocat/dotfiles'] });

    expect(maintained()).toEqual(['octocat/dotfiles']);
    expect(input().value).toBe('gadg');
    expect(document.activeElement).toBe(input());
    expect($('.suggestion')).toBe(row);
  });

  it('ignores the answer of a load that a newer one replaced', async () => {
    view();
    opener().click();
    $('.dialog-close').click();
    opener().click();
    expect(api.calls).toEqual(['catalogue', 'catalogue']);

    await api.fail('Too slow.');
    expect(note()).toBe('Loading your repositories…');
    await api.answer(CATALOGUE);
    expect(suggestions()).toHaveLength(3);
  });
});
