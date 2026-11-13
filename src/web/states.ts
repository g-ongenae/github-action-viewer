// How each run state looks, and the few words that explain a line whose badge alone would
// mislead (running on an older commit, failures while still running).

import { isFailedRunState, type RunState } from '../core/run-state.ts';
import type { LineView } from '../core/snapshot.ts';
import { plural } from './format.ts';

/**
 * Colour family of a state. Colour is never the only signal: every state also has its own icon
 * shape and text label.
 */
export type Tone = 'active' | 'success' | 'failure' | 'attention' | 'muted';

export interface StatePresentation {
  /** Badge text, e.g. "Running". */
  readonly label: string;
  /** The state inside a sentence, e.g. "running", "timed out". */
  readonly phrase: string;
  readonly tone: Tone;
}

/** Every run state, presented. The icon of each state is drawn by `icons.ts`. */
export const STATE_PRESENTATION: Readonly<Record<RunState, StatePresentation>> = {
  in_progress: { label: 'Running', phrase: 'running', tone: 'active' },
  queued: { label: 'Queued', phrase: 'queued', tone: 'active' },
  waiting: { label: 'Waiting', phrase: 'waiting for approval', tone: 'attention' },
  failure: { label: 'Failed', phrase: 'failed', tone: 'failure' },
  timed_out: { label: 'Timed out', phrase: 'timed out', tone: 'failure' },
  action_required: { label: 'Needs action', phrase: 'needs action', tone: 'attention' },
  cancelled: { label: 'Cancelled', phrase: 'cancelled', tone: 'muted' },
  unknown: { label: 'Unknown', phrase: 'in an unknown state', tone: 'muted' },
  stale: { label: 'Stale', phrase: 'abandoned by GitHub', tone: 'muted' },
  success: { label: 'Passed', phrase: 'passed', tone: 'success' },
  neutral: { label: 'Neutral', phrase: 'finished (neutral)', tone: 'muted' },
  skipped: { label: 'Skipped', phrase: 'skipped', tone: 'muted' },
};

/** A fragment of a line's note; `tone` highlights the parts that matter (failures). */
export interface NotePart {
  readonly text: string;
  readonly tone: Tone | null;
}

/**
 * What a line's badge does not say, in a few words; empty when the badge says it all.
 *
 * - The badge (`state`) reads active while anything on the ref runs, even on an older commit;
 *   the newest commit's own verdict (`commitState`) is then added: "running on an older commit ·
 *   newest commit passed".
 * - Failures among several runs: "1 of 4 failed", also while others still run.
 * - Draft pull requests say so.
 */
export function lineNote(line: LineView): NotePart[] {
  const parts: NotePart[] = [];
  const superseded = line.runs.filter((run) => run.superseded);
  if (line.state !== line.commitState) {
    // The badge's state can only differ from the newest commit's when it comes from a run of
    // an older commit.
    parts.push(
      { text: `${STATE_PRESENTATION[line.state].phrase} on an older commit`, tone: null },
      {
        text: `newest commit ${STATE_PRESENTATION[line.commitState].phrase}`,
        tone: toneOfVerdict(line.commitState),
      },
    );
  } else if (superseded.length > 0) {
    // Superseded runs are always active ones.
    parts.push({ text: `also ${plural(superseded.length, 'run')} on an older commit`, tone: null });
  }
  const total = currentRunCount(line);
  if (line.failed > 0 && (total > 1 || line.active)) {
    parts.push({ text: `${String(line.failed)} of ${String(total)} failed`, tone: 'failure' });
  }
  if (line.pullRequest?.draft === true) {
    parts.push({ text: 'draft', tone: null });
  }
  return parts;
}

/** Number of runs on the newest commit (superseded runs left out). */
export function currentRunCount(line: LineView): number {
  return Object.values(line.counts).reduce((sum, count) => sum + count, 0);
}

/** Tone used to highlight a commit's verdict in a note: only failures stand out. */
function toneOfVerdict(state: RunState): Tone | null {
  return isFailedRunState(state) ? 'failure' : null;
}
