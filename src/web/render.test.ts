// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { RUN_STATE_PRECEDENCE } from '../core/run-state.ts';
import type { PagePayload } from '../server/payload.ts';
import type { ConnectionState } from './connection.ts';
import { PageRenderer } from './render.ts';
import {
  configStatus,
  iso,
  lineIn,
  lineView,
  NOW,
  PAGE_SKELETON,
  payload,
  prLine,
  repositoryView,
  runView,
  snapshot,
  status,
} from './test-fixtures.ts';

let renderer: PageRenderer;

function render(
  shown: PagePayload | null,
  connection: ConnectionState = 'live',
  now: number = NOW,
): void {
  renderer.render({ payload: shown, connection, now });
}

const $ = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`No ${selector}`);
  }
  return found;
};
const $$ = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];
/** A line of the first repository. */
const lineOf = (key: string): HTMLElement => $(`.repository:first-child .line[data-key="${key}"]`);
const texts = (selector: string): string[] => $$(selector).map((node) => node.textContent);

const twoRepositories = (): PagePayload =>
  payload([
    repositoryView('octo-org/widgets', [
      lineIn('in_progress'),
      prLine(7, {
        runs: [runView({ id: 70, state: 'failure' }), runView({ id: 71, state: 'in_progress' })],
      }),
    ]),
    repositoryView('octo-org/gadgets', [lineIn('success')]),
  ]);

beforeEach(() => {
  document.title = '';
  document.body.innerHTML = PAGE_SKELETON;
  renderer = new PageRenderer(document);
});

describe('PageRenderer: initial render', () => {
  it('renders one section per repository and one line per ref, in the order received', () => {
    render(twoRepositories());
    expect(texts('.repository-name')).toEqual(['octo-org/widgets', 'octo-org/gadgets']);
    expect($$('.repository-name a').map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/octo-org/widgets',
      'https://github.com/octo-org/gadgets',
    ]);
    expect(texts('.repository:first-child .line-ref')).toEqual(['main', '#7']);
  });

  it('shows state, ref, date, commit title and author on each line', () => {
    render(twoRepositories());
    const line = lineOf('branch:main');
    expect(line.querySelector('.state-label')?.textContent).toBe('Running');
    expect(line.querySelector('svg.icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(line.querySelector('.line-ref a')?.getAttribute('href')).toBe(
      'https://github.com/octo-org/widgets/actions?query=branch%3Amain',
    );
    const time = line.querySelector('time.line-date');
    expect(time?.getAttribute('datetime')).toBe(iso(10));
    expect(time?.firstElementChild?.textContent).toBe('10 min ago');
    expect(time?.getAttribute('title')).not.toBe('');
    expect(time?.querySelector('.visually-hidden')?.textContent).toContain('2026');
    expect(line.querySelector('.line-title')?.textContent).toBe('Commit title');
    expect(line.querySelector('.line-author')?.textContent).toBe('Mona Lisa');
  });

  it('links pull request lines to the pull request and shows its title and failures', () => {
    render(twoRepositories());
    const line = lineOf('pr:7');
    expect(line.querySelector('.line-ref a')?.getAttribute('href')).toBe(
      'https://github.com/octo-org/widgets/pull/7',
    );
    expect(line.querySelector('.line-pr-title')?.textContent).toBe('Pull request 7');
    expect(line.querySelector('.line-note')?.textContent).toBe('1 of 2 failed');
  });

  it('opens links in a new tab without a handle on the page', () => {
    render(twoRepositories());
    for (const link of $$('a')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('gives every run state a label and an icon', () => {
    const lines = RUN_STATE_PRECEDENCE.map((state) =>
      lineIn(state, { key: `branch:${state}`, label: state }),
    );
    render(payload([repositoryView('o/r', lines)]));
    for (const state of RUN_STATE_PRECEDENCE) {
      const line = lineOf(`branch:${state}`);
      expect(line.classList.contains(`state-${state}`)).toBe(true);
      expect(line.querySelector('.state-label')?.textContent).not.toBe('');
      expect(line.querySelector(`svg.icon-${state}`)).not.toBeNull();
    }
  });

  it('sets the status, summary, tab title and favicon', () => {
    document.head.innerHTML = '<link id="favicon" rel="icon" href="favicon-quiet.svg">';
    renderer = new PageRenderer(document);
    render(twoRepositories());
    expect($('.connection-label').textContent).toBe('Live');
    expect($('.status-checked time span').textContent).toBe('just now');
    expect(texts('.summary-part')).toEqual(['2 running', '1 failed']);
    expect(document.title).toBe('2 running · 1 failed · My GitHub Actions');
    expect($('#favicon').getAttribute('href')).toBe('favicon-failed.svg');
  });
});

describe('PageRenderer: updates keep the reader’s state', () => {
  it('reuses the elements of unchanged keys and keeps expanded lines open', () => {
    render(twoRepositories());
    const section = $('.repository');
    const line = lineOf('pr:7');
    const toggle = line.querySelector<HTMLButtonElement>('.line-toggle');
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const run = line.querySelector('.run[data-key="70"]');
    expect(run).not.toBeNull();

    // The failed run passed on a re-run; everything else is the same.
    const next = payload([
      repositoryView('octo-org/widgets', [
        lineIn('in_progress'),
        prLine(7, {
          runs: [runView({ id: 70, state: 'success' }), runView({ id: 71, state: 'in_progress' })],
        }),
      ]),
      repositoryView('octo-org/gadgets', [lineIn('success')]),
    ]);
    render(next);

    expect($('.repository')).toBe(section);
    expect(lineOf('pr:7')).toBe(line);
    expect(line.querySelector('.run[data-key="70"]')).toBe(run);
    expect(run?.querySelector('.state-label')?.textContent).toBe('Passed');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(line.querySelector<HTMLElement>('.line-panel')?.hidden).toBe(false);
  });

  it('does not touch text that did not change (a selection inside it survives)', () => {
    render(twoRepositories());
    const titleText = lineOf('branch:main').querySelector('.line-title')?.firstChild;
    render(twoRepositories(), 'live', NOW + 60_000);
    expect(lineOf('branch:main').querySelector('.line-title')?.firstChild).toBe(titleText);
    expect(lineOf('branch:main').querySelector('time')?.firstElementChild?.textContent).toBe(
      '11 min ago',
    );
  });

  it('adds, removes and reorders lines and repositories by key', () => {
    render(twoRepositories());
    const main = lineOf('branch:main');
    const widgetsLine = (key: string): HTMLElement =>
      $(`.repository[data-key="octo-org/widgets"] .line[data-key="${key}"]`);
    const gadgets = $('.repository[data-key="octo-org/gadgets"]');

    render(
      payload([
        repositoryView('octo-org/gadgets', [lineIn('success')]),
        repositoryView('octo-org/widgets', [prLine(8), lineIn('success')]),
      ]),
    );

    expect($$('.repository').map((section) => section.dataset.key)).toEqual([
      'octo-org/gadgets',
      'octo-org/widgets',
    ]);
    expect($('.repository[data-key="octo-org/gadgets"]')).toBe(gadgets);
    expect(
      $$('.repository[data-key="octo-org/widgets"] .line').map((line) => line.dataset.key),
    ).toEqual(['pr:8', 'branch:main']);
    expect(widgetsLine('branch:main')).toBe(main);
    expect(document.querySelector('.line[data-key="pr:7"]')).toBeNull();
  });

  it('gives the focus back to an element that had to move', () => {
    render(twoRepositories());
    const toggle = lineOf('pr:7').querySelector<HTMLButtonElement>('.line-toggle');
    toggle?.focus();
    expect(document.activeElement).toBe(toggle);
    render(
      payload([
        repositoryView('octo-org/widgets', [
          prLine(7, { runs: [runView({ id: 70, state: 'failure' })] }),
          lineIn('in_progress'),
        ]),
      ]),
    );
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps a focused link of an expanded panel when the text around it changes', () => {
    render(twoRepositories());
    const line = lineOf('pr:7');
    line.querySelector<HTMLButtonElement>('.line-toggle')?.click();
    const commitLink = line.querySelector<HTMLAnchorElement>('.panel-commit a');
    const prLink = line.querySelector<HTMLAnchorElement>('.panel-pull-request a');
    commitLink?.focus();
    expect(document.activeElement).toBe(commitLink);
    expect(line.querySelector('.panel-commit')?.textContent).toContain('2 runs on this commit');

    // A third run starts: the count in the commit sentence changes.
    render(
      payload([
        repositoryView('octo-org/widgets', [
          lineIn('in_progress'),
          prLine(7, {
            runs: [
              runView({ id: 70, state: 'failure' }),
              runView({ id: 71, state: 'in_progress' }),
              runView({ id: 72, state: 'queued' }),
            ],
          }),
        ]),
        repositoryView('octo-org/gadgets', [lineIn('success')]),
      ]),
    );

    expect(line.querySelector('.panel-commit')?.textContent).toContain('3 runs on this commit');
    expect(line.querySelector('.panel-commit a')).toBe(commitLink);
    expect(line.querySelector('.panel-pull-request a')).toBe(prLink);
    expect(commitLink?.isConnected).toBe(true);
    expect(document.activeElement).toBe(commitLink);
  });

  it('remembers an expanded line that disappears and comes back', () => {
    render(twoRepositories());
    lineOf('pr:7').querySelector<HTMLButtonElement>('.line-toggle')?.click();
    render(payload([repositoryView('octo-org/widgets', [lineIn('in_progress')])]));
    render(twoRepositories());
    expect(lineOf('pr:7').querySelector('.line-toggle')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('collapses a line on a second click', () => {
    render(twoRepositories());
    const toggle = lineOf('pr:7').querySelector<HTMLButtonElement>('.line-toggle');
    toggle?.click();
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(lineOf('pr:7').querySelector<HTMLElement>('.line-panel')?.hidden).toBe(true);
  });
});

describe('PageRenderer: untrusted text', () => {
  const hostile = '<img src=x onerror="window.pwned=1">';

  it('renders markup in titles, names and branches as text', () => {
    render(
      payload([
        repositoryView('octo-org/widgets', [
          lineView({
            key: `branch:${hostile}`,
            kind: 'branch',
            label: hostile,
            commit: { sha: 'abc', title: hostile, authorName: hostile },
            runs: [runView({ workflowName: hostile, event: hostile })],
          }),
          prLine(9, {
            pullRequest: {
              number: 9,
              title: hostile,
              author: hostile,
              url: 'https://github.com/o/r/pull/9',
              draft: false,
            },
          }),
        ]),
      ]),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(texts('.line-title')).toEqual([hostile, 'Commit title']);
    expect(texts('.line-pr-title')).toEqual(['', hostile]);
    expect(texts('.line-author')).toEqual([hostile, 'Mona Lisa']);
    expect($('.line-ref').textContent).toBe(hostile);
  });

  it('drops links that are not https://github.com URLs, keeping the text', () => {
    render(
      payload([
        repositoryView(
          'evil/repo',
          [
            prLine(5, {
              pullRequest: {
                number: 5,
                title: 't',
                author: null,
                url: 'javascript:alert(1)',
                draft: false,
              },
              runs: [runView({ url: 'https://evil.example/run' })],
            }),
          ],
          { url: 'javascript:alert(document.cookie)' },
        ),
      ]),
    );
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(document.querySelector('a[href*="evil.example"]')).toBeNull();
    expect($('.repository-name').textContent).toBe('evil/repo');
    expect($('.line-ref').textContent).toBe('#5');
    expect($('.run-name').textContent).toBe('CI');
    for (const link of $$('a')) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
    }
  });
});

describe('PageRenderer: notices and empty states', () => {
  it('shows notices for stale data and configuration problems, and removes them when fixed', () => {
    render(
      payload([], {
        lastSuccessAt: iso(12),
        stale: { reason: 'collection_failed', message: 'Network down.', since: iso(10) },
        config: configStatus({
          state: 'invalid',
          problems: 'port: <b>bad</b>',
          fallback: 'last_valid',
        }),
      }),
    );
    expect($('#notices').hidden).toBe(false);
    expect(texts('.notice-title')).toEqual([
      'The configuration file has problems: the last valid configuration still applies.',
      'Showing data from 12 min ago: the latest checks failed.',
    ]);
    expect($('.notice-details.verbatim li').textContent).toBe('port: <b>bad</b>');

    render(payload([]));
    expect($('#notices').hidden).toBe(true);
    expect($$('.notice')).toHaveLength(0);
  });

  it('marks repositories kept from an earlier collection', () => {
    render({
      snapshot: snapshot([
        repositoryView('octo-org/widgets', [lineView()]),
        repositoryView('o/fresh', [lineView()]),
      ]),
      status: status({
        staleRepositories: [{ fullName: 'Octo-Org/Widgets', lastRefreshedAt: iso(20) }],
      }),
    });
    const stale = $('.repository[data-key="octo-org/widgets"]');
    expect(stale.classList.contains('repository-is-stale')).toBe(true);
    expect(stale.querySelector('.repository-stale')?.textContent).toBe(
      'May be out of date: could not be refreshed, data from 20 min ago.',
    );
    expect($('.repository[data-key="o/fresh"]').classList.contains('repository-is-stale')).toBe(
      false,
    );
  });

  it('walks through connecting, unreachable, first collection and nothing to show', () => {
    render(null, 'connecting');
    expect($('.empty-title').textContent).toBe('Connecting…');
    render(null, 'disconnected');
    expect($('.empty-title').textContent).toBe('Cannot reach the viewer’s server.');
    expect(document.title).toBe('Disconnected · My GitHub Actions');
    render(payload(null));
    expect($('.empty-title').textContent).toBe('Waiting for the first data from GitHub…');
    render(payload([]));
    expect($('.empty-title').textContent).toBe('No workflow runs to show.');
    expect(texts('#empty code')).toContain('config.json');
    render(twoRepositories());
    expect($('#empty').hidden).toBe(true);
  });

  it('announces politely, and only when there is something to say', () => {
    renderer.announce('');
    expect($('#announcer').textContent).toBe('');
    renderer.announce('octo-org/widgets main failed.');
    expect($('#announcer').textContent).toBe('octo-org/widgets main failed.');
  });
});
