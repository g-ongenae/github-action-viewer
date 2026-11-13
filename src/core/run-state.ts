/**
 * Normalised state of a workflow run, derived from GitHub's `status` + `conclusion` pair.
 *
 * Active states (the run is not finished): `in_progress`, `queued`, `waiting`.
 * Finished states: everything else.
 */
export type RunState =
  /** `status: in_progress`. */
  | 'in_progress'
  /** `status: queued`, `requested` or `pending`: accepted but not started. */
  | 'queued'
  /** `status: waiting`: paused on an environment protection rule (e.g. a required reviewer). */
  | 'waiting'
  /** `conclusion: failure` or `startup_failure` (the workflow file itself was invalid). */
  | 'failure'
  /** `conclusion: timed_out`. */
  | 'timed_out'
  /** `conclusion: action_required`: needs someone to act, e.g. approve a first-time contributor. */
  | 'action_required'
  /** `conclusion: cancelled`. */
  | 'cancelled'
  /** A value this code does not know (GitHub added one), or `completed` without a conclusion. */
  | 'unknown'
  /** `conclusion: stale`: GitHub gave up on a run that stayed incomplete too long. */
  | 'stale'
  /** `conclusion: success`. */
  | 'success'
  /** `conclusion: neutral`. */
  | 'neutral'
  /** `conclusion: skipped`. */
  | 'skipped';

/**
 * Every run state, from the highest to the lowest precedence. This is the single place that
 * decides how several runs combine into one line state ({@link summariseRunStates}): the line
 * takes the state of its highest-precedence run.
 *
 * - Active states come first: the page is about what is running *now*, so a line with anything
 *   still running reads as running (failures stay visible through {@link RunSummary.failed}).
 * - Then the finished states that need attention, worst first: failure, time-out, approval
 *   needed, cancellation.
 * - `unknown` sits above the good outcomes: an unrecognised value is not claimed to be green.
 * - `success` outranks `neutral` and `skipped`, so a line where some jobs were skipped and the
 *   others passed reads as a success; a line where everything was skipped reads as skipped.
 */
export const RUN_STATE_PRECEDENCE = [
  'in_progress',
  'queued',
  'waiting',
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
  'unknown',
  'stale',
  'success',
  'neutral',
  'skipped',
] as const satisfies readonly RunState[];

/**
 * Maps GitHub's workflow-run `status` and `conclusion` (both nullable strings) to a
 * {@link RunState}. A non-null conclusion always wins, since it means the run finished. Values
 * this code does not know map to `unknown` rather than throwing.
 */
export function normaliseRunState(status: string | null, conclusion: string | null): RunState {
  if (conclusion !== null) {
    switch (conclusion) {
      case 'success':
      case 'timed_out':
      case 'action_required':
      case 'cancelled':
      case 'stale':
      case 'neutral':
      case 'skipped':
        return conclusion;
      case 'failure':
      case 'startup_failure':
        return 'failure';
      default:
        return 'unknown';
    }
  }
  switch (status) {
    case 'in_progress':
    case 'waiting':
    case 'queued':
      return status;
    case 'requested':
    case 'pending':
      return 'queued';
    default:
      // `completed` without a conclusion, a status GitHub added later, or null.
      return 'unknown';
  }
}

/** Whether a run in this state has not finished yet. */
export function isActiveRunState(state: RunState): boolean {
  return state === 'in_progress' || state === 'queued' || state === 'waiting';
}

/** Whether a run in this state counts as failed (what a "1 failed" badge would count). */
export function isFailedRunState(state: RunState): boolean {
  return state === 'failure' || state === 'timed_out';
}

/** Several runs combined into what one line of the page shows. */
export interface RunSummary {
  /** The highest-precedence state among the runs (see {@link RUN_STATE_PRECEDENCE}). */
  readonly state: RunState;
  /** Number of runs in each state; every state is present, zero included. */
  readonly counts: Readonly<Record<RunState, number>>;
  /** Number of runs in a failed state, so the page can show "running, 1 failed". */
  readonly failed: number;
}

/**
 * Combines run states into a {@link RunSummary}. An empty list summarises to `unknown` (the
 * snapshot builder never produces an empty line).
 */
export function summariseRunStates(states: readonly RunState[]): RunSummary {
  const counts = Object.fromEntries(RUN_STATE_PRECEDENCE.map((state) => [state, 0])) as Record<
    RunState,
    number
  >;
  for (const state of states) {
    counts[state] += 1;
  }
  const state = RUN_STATE_PRECEDENCE.find((candidate) => counts[candidate] > 0) ?? 'unknown';
  const failed = states.filter(isFailedRunState).length;
  return { state, counts, failed };
}
