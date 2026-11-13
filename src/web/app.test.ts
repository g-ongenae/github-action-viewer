// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app.ts';
import {
  heartbeat,
  iso,
  lineIn,
  NOW,
  PAGE_SKELETON,
  payload,
  repositoryView,
} from './test-fixtures.ts';

let now = NOW;
let app: App;

beforeEach(() => {
  now = NOW;
  document.body.innerHTML = PAGE_SKELETON;
  app = new App(document, () => now);
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
});
