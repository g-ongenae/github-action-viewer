// Renders the page into the skeleton of index.html. Rendering is idempotent and incremental:
// repositories, lines and runs are matched to their elements by stable keys (repository name,
// line key, run id) and only what changed is touched, so a new payload or the clock ticking
// never closes an expanded line, moves the scroll position, clears a text selection or steals
// the focus.

import type { LineView, RepositoryView, RunView } from '../core/snapshot.ts';
import type { PagePayload, StaleRepository } from '../server/payload.ts';
import type { ConnectionState } from './connection.ts';
import {
  element,
  reconcile,
  restoreSelection,
  saveSelection,
  setAttribute,
  setClassName,
  setLink,
  setText,
} from './dom.ts';
import { formatAgo, formatExact, plural } from './format.ts';
import { setStateIcon } from './icons.ts';
import { collectNotices, emptyState, type EmptyState, type Notice } from './notices.ts';
import { currentRunCount, lineNote, STATE_PRESENTATION } from './states.ts';
import { summarise, summaryParts, tabState } from './summary.ts';
import { branchRunsUrl } from './urls.ts';

export interface ViewState {
  /** The latest payload, with the latest heartbeat's fields applied; null before the first. */
  readonly payload: PagePayload | null;
  readonly connection: ConnectionState;
  /** Current time, milliseconds since the epoch. */
  readonly now: number;
}

const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

/** Elements of a line kept between renders, so updates never search the DOM. */
interface LineParts {
  readonly toggle: HTMLButtonElement;
  readonly stateLabel: HTMLElement;
  readonly toggleHint: HTMLElement;
  readonly ref: HTMLElement;
  readonly date: HTMLTimeElement;
  readonly title: HTMLElement;
  readonly prTitle: HTMLElement;
  readonly author: HTMLElement;
  readonly note: HTMLElement;
  readonly panel: HTMLElement;
  readonly commit: HTMLElement;
  readonly pullRequest: HTMLElement;
  readonly runs: HTMLUListElement;
}

/** What `updateLine` needs besides the line. */
interface LineContext {
  readonly repository: RepositoryView;
  readonly line: LineView;
  readonly now: number;
}

export class PageRenderer {
  readonly #document: Document;
  readonly #status: HTMLElement;
  readonly #notices: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #repositories: HTMLElement;
  readonly #announcer: HTMLElement;
  readonly #favicon: HTMLLinkElement | null;
  /** Lines the reader expanded, by `<repository>\n<line key>`; survives a line disappearing. */
  readonly #expanded = new Set<string>();
  readonly #lineParts = new WeakMap<HTMLElement, LineParts>();
  #nextId = 0;

  constructor(document: Document) {
    this.#document = document;
    this.#status = required(document, 'status');
    this.#notices = required(document, 'notices');
    this.#empty = required(document, 'empty');
    this.#repositories = required(document, 'repositories');
    this.#announcer = required(document, 'announcer');
    const favicon = document.getElementById('favicon');
    this.#favicon = favicon instanceof HTMLLinkElement ? favicon : null;
  }

  render(view: ViewState): void {
    const focused = this.#document.activeElement;
    const selection = saveSelection(this.#document);
    const snapshot = view.payload?.snapshot ?? null;
    const summary = summarise(snapshot);

    this.#renderStatus(view, snapshot === null ? null : summaryParts(summary));
    this.#renderNotices(collectNotices(view.payload, view.now));
    this.#renderEmpty(emptyState(view.payload, view.connection));
    this.#renderRepositories(
      snapshot?.repositories ?? [],
      view.payload?.status.staleRepositories ?? [],
      view.now,
    );

    const tab = tabState(summary, view.connection);
    if (this.#document.title !== tab.title) {
      this.#document.title = tab.title;
    }
    if (this.#favicon !== null) {
      setAttribute(this.#favicon, 'href', `favicon-${tab.favicon}.svg`);
    }

    // Moving an element blurs it in some browsers; give the focus back where it was.
    if (
      focused instanceof HTMLElement &&
      focused !== this.#document.activeElement &&
      focused.isConnected
    ) {
      focused.focus({ preventScroll: true });
    }
    // Moving a node clears a selection inside it, even with `moveBefore`: put it back.
    restoreSelection(this.#document, selection);
  }

  /** Says `message` politely to assistive technology; nothing for an empty message. */
  announce(message: string): void {
    if (message !== '') {
      setText(this.#announcer, message);
    }
  }

  #renderStatus(view: ViewState, summary: ReturnType<typeof summaryParts> | null): void {
    let connection = this.#status.querySelector<HTMLElement>('.connection');
    let checked = this.#status.querySelector<HTMLElement>('.status-checked');
    let parts = this.#status.querySelector<HTMLElement>('.summary');
    if (connection === null || checked === null || parts === null) {
      connection = element('span', 'connection');
      connection.append(element('span', 'connection-dot'), element('span', 'connection-label'));
      checked = element('span', 'status-checked');
      checked.append('checked ', element('time'));
      parts = element('span', 'summary');
      this.#status.replaceChildren(connection, checked, parts);
    }

    connection.dataset.state = view.connection;
    setText(connection.lastElementChild ?? connection, CONNECTION_LABELS[view.connection]);

    const lastCheckedAt = view.payload?.status.lastCheckedAt ?? null;
    checked.hidden = lastCheckedAt === null;
    const time = checked.querySelector('time');
    if (lastCheckedAt !== null && time !== null) {
      setTime(time, lastCheckedAt, view.now);
    }

    parts.hidden = summary === null;
    const signature = JSON.stringify(summary);
    if (parts.dataset.signature !== signature) {
      parts.dataset.signature = signature;
      parts.replaceChildren(
        ...(summary ?? []).map((part) => {
          const span = element('span', `summary-part tone-${part.tone}`);
          span.textContent = part.text;
          return span;
        }),
      );
    }
  }

  #renderNotices(notices: readonly Notice[]): void {
    this.#notices.hidden = notices.length === 0;
    reconcile(
      this.#notices,
      notices,
      (notice) => notice.key,
      () => {
        const item = element('li');
        item.append(element('p', 'notice-title'), element('ul', 'notice-details'));
        return item;
      },
      (item, notice) => {
        setClassName(item, `notice notice-${notice.tone}`);
        const [title, details] = item.children;
        if (title !== undefined && details !== undefined) {
          setText(title, notice.title);
          setClassName(details, notice.verbatim ? 'notice-details verbatim' : 'notice-details');
          (details as HTMLElement).hidden = notice.details.length === 0;
          reconcile(
            details,
            notice.details.map((text, index) => ({ text, index })),
            (detail) => String(detail.index),
            () => element('li'),
            (line, detail) => {
              setText(line, detail.text);
            },
          );
        }
      },
    );
  }

  #renderEmpty(state: EmptyState | null): void {
    this.#empty.hidden = state === null;
    const signature = JSON.stringify(state);
    if (this.#empty.dataset.signature === signature) {
      return;
    }
    this.#empty.dataset.signature = signature;
    if (state === null) {
      this.#empty.replaceChildren();
      return;
    }
    const title = element('p', 'empty-title');
    title.textContent = state.title;
    const paragraphs = state.paragraphs.map((inlines) => {
      const paragraph = element('p');
      for (const inline of inlines) {
        if (typeof inline === 'string') {
          paragraph.append(inline);
        } else {
          const code = element('code');
          code.textContent = inline.code;
          paragraph.append(code);
        }
      }
      return paragraph;
    });
    this.#empty.replaceChildren(title, ...paragraphs);
  }

  #renderRepositories(
    repositories: readonly RepositoryView[],
    staleRepositories: readonly StaleRepository[],
    now: number,
  ): void {
    const stale = new Map(
      staleRepositories.map((entry) => [entry.fullName.toLowerCase(), entry.lastRefreshedAt]),
    );
    reconcile(
      this.#repositories,
      repositories,
      (repository) => repository.fullName,
      () => this.#createRepository(),
      (section, repository) => {
        this.#updateRepository(
          section,
          repository,
          stale.get(repository.fullName.toLowerCase()) ?? null,
          now,
        );
      },
    );
  }

  #createRepository(): HTMLElement {
    const section = element('section', 'repository');
    const header = element('header', 'repository-header');
    const heading = element('h2', 'repository-name');
    heading.id = this.#id('repository');
    section.setAttribute('aria-labelledby', heading.id);
    const staleNote = element('p', 'repository-stale');
    header.append(heading, staleNote);
    const lines = element('ul', 'lines');
    // `list-style: none` makes some screen readers forget that this is a list.
    lines.setAttribute('role', 'list');
    section.append(header, lines);
    return section;
  }

  #updateRepository(
    section: HTMLElement,
    repository: RepositoryView,
    lastRefreshedAt: string | null,
    now: number,
  ): void {
    const header = section.firstElementChild;
    const heading = header?.firstElementChild;
    const staleNote = header?.lastElementChild;
    const lines = section.lastElementChild;
    if (
      !(heading instanceof HTMLElement) ||
      !(staleNote instanceof HTMLElement) ||
      lines === null
    ) {
      return;
    }
    setLink(heading, repository.url, repository.fullName);
    section.classList.toggle('repository-is-stale', lastRefreshedAt !== null);
    staleNote.hidden = lastRefreshedAt === null;
    if (lastRefreshedAt !== null) {
      setText(
        staleNote,
        `May be out of date: could not be refreshed, data from ${formatAgo(lastRefreshedAt, now)}.`,
      );
    }
    reconcile(
      lines,
      repository.lines,
      (line) => line.key,
      () => this.#createLine(),
      (item, line) => {
        this.#updateLine(item, { repository, line, now });
      },
    );
  }

  #createLine(): HTMLElement {
    const item = element('li', 'line');
    const row = element('div', 'line-row');

    const toggle = element('button', 'line-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const chevron = element('span', 'chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const stateLabel = element('span', 'state-label');
    const toggleHint = element('span', 'visually-hidden');
    toggle.append(chevron, stateLabel, toggleHint);

    const ref = element('span', 'line-ref');
    const date = element('time', 'line-date');
    const text = element('span', 'line-text');
    const title = element('bdi', 'line-title');
    const prTitle = element('bdi', 'line-pr-title');
    const author = element('bdi', 'line-author');
    text.append(title, prTitle, author);
    const note = element('p', 'line-note');
    row.append(toggle, ref, date, text, note);

    const panel = element('div', 'line-panel');
    panel.id = this.#id('runs');
    panel.hidden = true;
    toggle.setAttribute('aria-controls', panel.id);
    const commit = element('p', 'panel-commit');
    const pullRequest = element('p', 'panel-pull-request');
    const runs = element('ul', 'runs');
    runs.setAttribute('role', 'list');
    panel.append(commit, pullRequest, runs);

    item.append(row, panel);
    this.#lineParts.set(item, {
      toggle,
      stateLabel,
      toggleHint,
      ref,
      date,
      title,
      prTitle,
      author,
      note,
      panel,
      commit,
      pullRequest,
      runs,
    });

    toggle.addEventListener('click', () => {
      const id = item.dataset.lineId;
      if (id === undefined) {
        return;
      }
      const open = !this.#expanded.has(id);
      if (open) {
        this.#expanded.add(id);
      } else {
        this.#expanded.delete(id);
      }
      setExpanded(toggle, panel, open);
    });
    return item;
  }

  #updateLine(item: HTMLElement, { repository, line, now }: LineContext): void {
    const parts = this.#lineParts.get(item);
    if (parts === undefined) {
      return;
    }
    const presentation = STATE_PRESENTATION[line.state];
    const lineId = `${repository.fullName}\n${line.key}`;
    item.dataset.lineId = lineId;
    setClassName(item, `line state-${line.state} tone-${presentation.tone}`);

    setStateIcon(parts.toggle, line.state);
    setText(parts.stateLabel, presentation.label);
    setText(parts.toggleHint, `, ${plural(line.runs.length, 'workflow run')}`);
    setExpanded(parts.toggle, parts.panel, this.#expanded.has(lineId));

    const pr = line.pullRequest;
    const refUrl = pr === null ? branchRunsUrl(repository.url, branchName(line)) : pr.url;
    setLink(parts.ref, refUrl, line.label, {
      title: pr === null ? `Workflow runs of ${line.label}` : `${pr.title} (#${String(pr.number)})`,
    });
    setTime(parts.date, line.date, now);

    setText(parts.title, line.commit.title);
    setAttribute(parts.title, 'title', line.commit.title);
    const showPrTitle = pr !== null && pr.title !== line.commit.title;
    parts.prTitle.hidden = !showPrTitle;
    setText(parts.prTitle, showPrTitle ? pr.title : '');
    setAttribute(parts.prTitle, 'title', showPrTitle ? `Pull request: ${pr.title}` : null);
    const author = line.commit.authorName ?? pr?.author ?? 'unknown author';
    setText(parts.author, author);
    setAttribute(parts.author, 'title', author);

    renderNote(parts.note, line);
    this.#renderPanel(parts, repository, line, now);
  }

  #renderPanel(parts: LineParts, repository: RepositoryView, line: LineView, now: number): void {
    const sha = line.commit.sha.slice(0, 7);
    renderInlines(parts.commit, [
      'Commit ',
      { link: `${repository.url}/commit/${line.commit.sha}`, text: sha, className: 'sha' },
      ' · ',
      { bdi: line.commit.title },
      ' · ',
      { bdi: line.commit.authorName ?? 'unknown author' },
      ` · ${plural(currentRunCount(line), 'run')} on this commit`,
    ]);

    const pr = line.pullRequest;
    parts.pullRequest.hidden = pr === null;
    if (pr !== null) {
      renderInlines(parts.pullRequest, [
        pr.draft ? 'Draft pull request ' : 'Pull request ',
        { link: pr.url, text: `#${String(pr.number)}` },
        ': ',
        { bdi: pr.title },
        ...(pr.author === null ? [] : [' by ', { bdi: pr.author }]),
      ]);
    }

    reconcile(
      parts.runs,
      line.runs,
      (run) => String(run.id),
      createRun,
      (item, run) => {
        updateRun(item, run, repository, now);
      },
    );
  }

  #id(prefix: string): string {
    this.#nextId += 1;
    return `${prefix}-${String(this.#nextId)}`;
  }
}

function required(document: Document, id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The page has no #${id} element.`);
  }
  return found;
}

function setExpanded(toggle: HTMLElement, panel: HTMLElement, open: boolean): void {
  setAttribute(toggle, 'aria-expanded', String(open));
  panel.hidden = !open;
}

/** The branch a branch line follows: its key without the `branch:` prefix. */
function branchName(line: LineView): string {
  return line.key.startsWith('branch:') ? line.key.slice('branch:'.length) : line.label;
}

/**
 * Shows a relative time that keeps ticking, with the exact time in the tooltip and, for
 * assistive technology, in hidden text next to it.
 */
function setTime(time: HTMLTimeElement, iso: string, now: number): void {
  let relative = time.firstElementChild;
  let exact = time.lastElementChild;
  if (relative === null || exact === null || relative === exact) {
    relative = element('span');
    exact = element('span', 'visually-hidden');
    time.replaceChildren(relative, exact);
  }
  const exactText = formatExact(iso);
  setAttribute(time, 'datetime', iso);
  setAttribute(time, 'title', exactText);
  setText(relative, formatAgo(iso, now));
  setText(exact, ` (${exactText})`);
}

function renderNote(note: HTMLElement, line: LineView): void {
  const parts = lineNote(line);
  note.hidden = parts.length === 0;
  const signature = JSON.stringify(parts);
  if (note.dataset.signature === signature) {
    return;
  }
  note.dataset.signature = signature;
  note.replaceChildren(
    ...parts.map((part) => {
      const span = element(
        'span',
        part.tone === null ? 'note-part' : `note-part tone-${part.tone}`,
      );
      span.textContent = part.text;
      return span;
    }),
  );
}

/** A piece of a sentence: plain text, isolated text written by someone else, or a link. */
type InlinePiece =
  | string
  | { readonly bdi: string }
  | { readonly link: string; readonly text: string; readonly className?: string };

/**
 * Makes `container` show `pieces`, one element per piece, matched by position and kind: a piece
 * whose neighbours changed (say, a run count) keeps its element, so a focused link in the
 * sentence stays focused.
 */
function renderInlines(container: HTMLElement, pieces: readonly InlinePiece[]): void {
  const kindOf = (piece: InlinePiece): string =>
    typeof piece === 'string' ? 'text' : 'bdi' in piece ? 'bdi' : 'link';
  reconcile(
    container,
    pieces.map((piece, index) => ({ piece, index })),
    ({ piece, index }) => `${String(index)}:${kindOf(piece)}`,
    ({ piece }) => element(kindOf(piece) === 'bdi' ? 'bdi' : 'span'),
    (target, { piece }) => {
      if (typeof piece === 'string') {
        setText(target, piece);
      } else if ('bdi' in piece) {
        setText(target, piece.bdi);
      } else {
        setLink(
          target,
          piece.link,
          piece.text,
          piece.className === undefined ? {} : { className: piece.className },
        );
      }
    },
  );
}

function createRun(): HTMLElement {
  const item = element('li', 'run');
  item.append(
    element('span', 'run-state'),
    element('span', 'run-name'),
    element('span', 'run-event'),
    element('span', 'run-number'),
    element('time', 'run-date'),
    element('span', 'run-commit'),
  );
  return item;
}

function updateRun(item: HTMLElement, run: RunView, repository: RepositoryView, now: number): void {
  const [state, name, event, number, date, commit] = item.children;
  if (
    !(state instanceof HTMLElement) ||
    name === undefined ||
    event === undefined ||
    number === undefined ||
    !(date instanceof HTMLTimeElement) ||
    commit === undefined
  ) {
    return;
  }
  const presentation = STATE_PRESENTATION[run.state];
  setClassName(item, `run state-${run.state} tone-${presentation.tone}`);
  let label = state.querySelector('.state-label');
  if (label === null) {
    label = element('span', 'state-label');
    state.append(label);
  }
  setStateIcon(state, run.state);
  setText(label, presentation.label);
  setLink(name, run.url, run.workflowName, {
    title: `${run.workflowName}: open the run on GitHub`,
  });
  setText(event, run.event);
  setAttribute(event, 'title', run.event);
  const numberText =
    run.runAttempt > 1
      ? `#${String(run.runNumber)} · attempt ${String(run.runAttempt)}`
      : `#${String(run.runNumber)}`;
  setText(number, numberText);
  setAttribute(number, 'title', numberText);
  setTime(date, run.startedAt ?? run.createdAt, now);
  if (run.superseded) {
    setLink(
      commit,
      `${repository.url}/commit/${run.headSha}`,
      `older commit ${run.headSha.slice(0, 7)}`,
      { title: `Runs on an older commit: ${run.headSha}` },
    );
  } else {
    commit.replaceChildren();
  }
}
