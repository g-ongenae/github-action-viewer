import { describe, expect, it } from 'vitest';
import { RUN_STATE_PRECEDENCE } from '../core/run-state.ts';
import { DEMO_VARIANTS, demoPayload } from './payload.ts';

const START = Date.parse('2026-11-13T12:00:00Z');

describe('demoPayload', () => {
  const full = demoPayload('full', START, START + 1_000, 0);
  const lines = full.snapshot?.repositories.flatMap((repository) => repository.lines) ?? [];

  it('shows every run state, on a line or in its runs', () => {
    const states = new Set(
      lines.flatMap((line) => [line.state, ...line.runs.map((run) => run.state)]),
    );
    expect([...states].sort()).toEqual([...RUN_STATE_PRECEDENCE].sort());
  });

  it('covers the situations the page handles', () => {
    expect(lines.some((line) => line.state !== line.commitState)).toBe(true);
    expect(lines.some((line) => line.active && line.failed > 0)).toBe(true);
    expect(lines.some((line) => line.pullRequest?.draft === true)).toBe(true);
    expect(full.status.staleRepositories).not.toHaveLength(0);
    expect(full.status.config.state).toBe('invalid');
    expect(full.status.pollInterval.reason).toBe('budget');
    expect(full.snapshot?.problems.map((problem) => problem.kind)).toContain('other');
  });

  it('only links to github.com', () => {
    const urls = [
      ...(full.snapshot?.repositories.map((repository) => repository.url) ?? []),
      ...lines.flatMap((line) => [
        ...line.runs.map((run) => run.url),
        line.pullRequest?.url ?? 'https://github.com/',
      ]),
    ];
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('moves the story forward from one step to the next', () => {
    expect(JSON.stringify(demoPayload('full', START, START, 1).snapshot)).not.toBe(
      JSON.stringify(demoPayload('full', START, START, 0).snapshot),
    );
  });

  it('has an empty, a first-load and a failing variant', () => {
    expect(DEMO_VARIANTS).toEqual(['full', 'failing', 'empty', 'first-load']);
    expect(demoPayload('empty', START, START, 0).snapshot?.repositories).toEqual([]);
    expect(demoPayload('first-load', START, START, 0).snapshot).toBeNull();
    expect(demoPayload('failing', START, START, 0).status.stale?.reason).toBe('collection_failed');
  });
});
