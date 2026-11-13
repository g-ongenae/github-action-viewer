import { describe, expect, it } from 'vitest';
import { RUN_STATE_PRECEDENCE } from '../core/run-state.ts';
import { lineNote, STATE_PRESENTATION } from './states.ts';
import { lineView, prLine, runView } from './test-fixtures.ts';

describe('STATE_PRESENTATION', () => {
  it('presents every run state with a distinct label', () => {
    expect(Object.keys(STATE_PRESENTATION).sort()).toEqual([...RUN_STATE_PRECEDENCE].sort());
    const labels = Object.values(STATE_PRESENTATION).map((presentation) => presentation.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives failures the failure tone and active states the active or attention tone', () => {
    expect(STATE_PRESENTATION.failure.tone).toBe('failure');
    expect(STATE_PRESENTATION.timed_out.tone).toBe('failure');
    expect(STATE_PRESENTATION.in_progress.tone).toBe('active');
    expect(STATE_PRESENTATION.queued.tone).toBe('active');
    expect(STATE_PRESENTATION.waiting.tone).toBe('attention');
    expect(STATE_PRESENTATION.success.tone).toBe('success');
  });
});

describe('lineNote', () => {
  it('is empty for a plain line', () => {
    expect(lineNote(lineView())).toEqual([]);
  });

  it('explains a line running on an older commit whose newest commit passed', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'success' }),
        runView({ id: 2, state: 'in_progress', superseded: true, headSha: 'old' }),
      ],
    });
    expect(line.state).toBe('in_progress');
    expect(lineNote(line).map((part) => part.text)).toEqual([
      'running on an older commit',
      'newest commit passed',
    ]);
  });

  it('highlights a newest commit that failed while an older one still runs', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'failure' }),
        runView({ id: 2, state: 'queued', superseded: true, headSha: 'old' }),
      ],
    });
    expect(lineNote(line)).toContainEqual({ text: 'newest commit failed', tone: 'failure' });
  });

  it('mentions superseded runs when the badge already matches the newest commit', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'in_progress' }),
        runView({ id: 2, state: 'in_progress', superseded: true, headSha: 'old' }),
      ],
    });
    expect(lineNote(line).map((part) => part.text)).toEqual(['also 1 run on an older commit']);
  });

  it('shows failures of a line that is still running', () => {
    const line = lineView({
      runs: [
        runView({ id: 1, state: 'failure' }),
        runView({ id: 2, state: 'in_progress' }),
        runView({ id: 3, state: 'success' }),
      ],
    });
    expect(line.state).toBe('in_progress');
    expect(lineNote(line)).toEqual([{ text: '1 of 3 failed', tone: 'failure' }]);
  });

  it('does not repeat a single failed run that the badge already shows', () => {
    expect(lineNote(lineView({ runs: [runView({ state: 'failure' })] }))).toEqual([]);
  });

  it('says when a pull request is a draft', () => {
    const line = prLine(4, {
      pullRequest: {
        number: 4,
        title: 't',
        author: null,
        url: 'https://github.com/a/b/pull/4',
        draft: true,
      },
    });
    expect(lineNote(line)).toEqual([{ text: 'draft', tone: null }]);
  });
});
