import { describe, expect, it } from 'vitest';

import {
  isActiveRunState,
  isFailedRunState,
  normaliseRunState,
  RUN_STATE_PRECEDENCE,
  type RunState,
  summariseRunStates,
} from './run-state.ts';

describe('normaliseRunState', () => {
  it.each<[string | null, string | null, RunState]>([
    // Not finished: the status decides.
    ['queued', null, 'queued'],
    ['requested', null, 'queued'],
    ['pending', null, 'queued'],
    ['waiting', null, 'waiting'],
    ['in_progress', null, 'in_progress'],
    // Finished: the conclusion decides.
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'failure'],
    ['completed', 'startup_failure', 'failure'],
    ['completed', 'timed_out', 'timed_out'],
    ['completed', 'action_required', 'action_required'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'neutral', 'neutral'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'stale', 'stale'],
    // A conclusion wins over a status that disagrees.
    ['in_progress', 'cancelled', 'cancelled'],
    // Values GitHub may add later, and inconsistent pairs, never throw.
    ['completed', null, 'unknown'],
    ['completed', 'brand_new_conclusion', 'unknown'],
    ['brand_new_status', null, 'unknown'],
    [null, null, 'unknown'],
    [null, 'success', 'success'],
  ])('maps status %j + conclusion %j to %s', (status, conclusion, expected) => {
    expect(normaliseRunState(status, conclusion)).toBe(expected);
  });
});

describe('isActiveRunState / isFailedRunState', () => {
  it.each<[RunState, boolean, boolean]>([
    ['in_progress', true, false],
    ['queued', true, false],
    ['waiting', true, false],
    ['failure', false, true],
    ['timed_out', false, true],
    ['action_required', false, false],
    ['cancelled', false, false],
    ['unknown', false, false],
    ['stale', false, false],
    ['success', false, false],
    ['neutral', false, false],
    ['skipped', false, false],
  ])('%s: active %s, failed %s', (state, active, failed) => {
    expect(isActiveRunState(state)).toBe(active);
    expect(isFailedRunState(state)).toBe(failed);
  });

  it('lists every state exactly once in the precedence', () => {
    expect(new Set(RUN_STATE_PRECEDENCE).size).toBe(RUN_STATE_PRECEDENCE.length);
    expect(RUN_STATE_PRECEDENCE).toHaveLength(12);
  });
});

describe('summariseRunStates', () => {
  it.each<[RunState[], RunState, number]>([
    // Anything active makes the line active, even next to failures…
    [['success', 'failure', 'in_progress'], 'in_progress', 1],
    [['failure', 'queued'], 'queued', 1],
    [['in_progress', 'queued', 'waiting'], 'in_progress', 0],
    [['queued', 'waiting'], 'queued', 0],
    [['waiting', 'success'], 'waiting', 0],
    // …otherwise the worst outcome wins.
    [['success', 'failure', 'timed_out'], 'failure', 2],
    [['success', 'timed_out'], 'timed_out', 1],
    [['success', 'action_required', 'cancelled'], 'action_required', 0],
    [['success', 'cancelled'], 'cancelled', 0],
    [['success', 'unknown'], 'unknown', 0],
    [['success', 'stale'], 'stale', 0],
    // Skipped and neutral runs do not hide a success; all-skipped reads as skipped.
    [['skipped', 'success', 'neutral'], 'success', 0],
    [['skipped', 'neutral'], 'neutral', 0],
    [['skipped', 'skipped'], 'skipped', 0],
    [[], 'unknown', 0],
  ])('%j → %s with %d failed', (states, state, failed) => {
    const summary = summariseRunStates(states);
    expect(summary.state).toBe(state);
    expect(summary.failed).toBe(failed);
  });

  it('counts every state, zeros included', () => {
    const { counts } = summariseRunStates(['success', 'failure', 'success']);
    expect(counts.success).toBe(2);
    expect(counts.failure).toBe(1);
    expect(counts.in_progress).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...RUN_STATE_PRECEDENCE].sort());
  });
});
