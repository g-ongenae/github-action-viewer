// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './app.ts';
import {
  configStatus,
  heartbeat,
  iso,
  lineIn,
  NOW,
  PAGE_SKELETON,
  payload,
  prLine,
  repositoryView,
  runView,
} from './test-fixtures.ts';

let now = NOW;
let app: App;

beforeEach(() => {
  now = NOW;
  document.body.innerHTML = PAGE_SKELETON;
  app = new App(document, () => now, {
    catalogue: () => Promise.resolve({ ok: true, value: { repositories: [], complete: true } }),
    add: () => Promise.resolve({ ok: false, message: 'Not in this test.' }),
    remove: () => Promise.resolve({ ok: false, message: 'Not in this test.' }),
  });
});

const text = (selector: string): string | null =>
  document.querySelector(selector)?.textContent ?? null;
/** The relative time shown for the last check (without its hidden exact time). */
const checked = (): string | null => text('.status-checked time span');

describe('App', () => {
  it('starts connecting', () => {
    expect(text('.connection-label')).toBe('Connecting…');
    expect(text('.empty-title')).toBe('Connecting…');
  });

  it('updates the last check from heartbeats and keeps it ticking', () => {
    app.setConnection('live');
    app.setPayload(
      payload([repositoryView('o/r', [lineIn('success')])], { lastCheckedAt: iso(5) }),
    );
    expect(checked()).toBe('5 min ago');

    app.applyHeartbeat(heartbeat({ lastCheckedAt: iso(0.5) }));
    expect(checked()).toBe('30 s ago');

    now += 20_000;
    app.render();
    expect(checked()).toBe('50 s ago');
  });

  it('shows the slowed-down interval that a heartbeat reports', () => {
    app.setPayload(payload([]));
    app.applyHeartbeat(
      heartbeat({ pollInterval: { baseSeconds: 15, currentSeconds: 45, reason: 'budget' } }),
    );
    expect(text('.notice-title')).toBe(
      'Checking every 45 s instead of every 15 s, to save GitHub API quota.',
    );
    // A newer payload carries its own values.
    app.setPayload(payload([]));
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('announces finished lines and connection changes', () => {
    app.setConnection('live');
    app.setPayload(payload([repositoryView('o/r', [lineIn('in_progress')])]));
    expect(text('#announcer')).toBe('');
    app.setPayload(payload([repositoryView('o/r', [lineIn('failure')])]));
    expect(text('#announcer')).toBe('o/r main failed.');

    app.setConnection('reconnecting');
    app.setConnection('disconnected');
    expect(text('#announcer')).toBe('Connection to the viewer lost; retrying.');
    expect(text('.connection-label')).toBe('Disconnected');
    app.setConnection('live');
    expect(text('#announcer')).toBe('Reconnected.');
  });

  it('offers to add repositories once the server allows it, with the list it publishes', () => {
    const opener = document.querySelector<HTMLButtonElement>('#add-repository');
    expect(opener?.hidden).toBe(true);

    app.setPayload(payload([], { config: configStatus({ maintainedRepositories: ['o/added'] }) }));
    expect(opener?.hidden).toBe(false);
    opener?.click();
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(text('.maintained-name')).toBe('o/added');

    app.setPayload(payload([], { config: configStatus({ editing: 'off' }) }));
    expect(opener?.hidden).toBe(true);
  });

  describe('status filter', () => {
    const chip = (label: string): HTMLButtonElement => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('.filter')].find(
        (button) => button.querySelector('.filter-label')?.textContent === label,
      );
      if (found === undefined) {
        throw new Error(`No ${label} chip`);
      }
      return found;
    };
    const refs = (): string[] =>
      [...document.querySelectorAll('.line-ref')].map((ref) => ref.textContent);
    const showAll = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>('.filter-clear');
    const busy = payload([
      repositoryView('o/r', [
        lineIn('in_progress'),
        prLine(1, { runs: [runView({ state: 'failure' })] }),
        prLine(2, { runs: [runView({ state: 'success' })] }),
      ]),
    ]);

    afterEach(() => {
      history.replaceState(null, '', '/');
    });

    it('stays hidden until there are lines to filter', () => {
      expect(document.querySelector<HTMLElement>('#filters')?.hidden).toBe(true);
      app.setPayload(payload([]));
      expect(document.querySelector<HTMLElement>('#filters')?.hidden).toBe(true);
      app.setPayload(busy);
      expect(document.querySelector<HTMLElement>('#filters')?.hidden).toBe(false);
    });

    it('counts the lines of each status', () => {
      app.setPayload(busy);
      expect(
        [...document.querySelectorAll('.filter')].map((button) => [
          button.querySelector('.filter-label')?.textContent,
          button.querySelector('.filter-count')?.textContent,
          button.classList.contains('filter-is-empty'),
        ]),
      ).toEqual([
        ['Running', '1', false],
        ['Failed', '1', false],
        ['Waiting', '0', true],
        ['Passed', '1', false],
        ['Other', '0', true],
      ]);
    });

    it('toggles statuses, keeps them in the address, and shows all again', () => {
      app.setPayload(busy);
      expect(showAll()?.hidden).toBe(true);

      chip('Failed').click();
      expect(chip('Failed').getAttribute('aria-pressed')).toBe('true');
      expect(refs()).toEqual(['#1']);
      expect(location.search).toBe('?status=failed');
      expect(showAll()?.hidden).toBe(false);

      chip('Running').click();
      expect(refs()).toEqual(['main', '#1']);
      expect(location.search).toBe('?status=running,failed');

      chip('Failed').click();
      expect(refs()).toEqual(['main']);

      showAll()?.click();
      expect(refs()).toEqual(['main', '#1', '#2']);
      expect(location.search).toBe('');
      expect(chip('Running').getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).toBe(chip('Running'));
    });

    it('starts from the statuses in the address', () => {
      history.replaceState(null, '', '/?status=passed');
      document.body.innerHTML = PAGE_SKELETON;
      const reloaded = new App(document, () => now);
      reloaded.setPayload(busy);
      expect(refs()).toEqual(['#2']);
      expect(chip('Passed').getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('needs the button of the page skeleton', () => {
    document.body.innerHTML = PAGE_SKELETON.replace('id="add-repository"', '');
    expect(() => new App(document)).toThrow('The page has no #add-repository button.');
  });
});
