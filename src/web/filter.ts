// The status filter: which lines each status chip matches, and the chips chosen, as kept in the
// page's address (`?status=failed,waiting`) so that a reload or a bookmark keeps them.

import type { RunState } from '../core/run-state.ts';
import type { LineView, RepositoryView } from '../core/snapshot.ts';
import type { Tone } from './states.ts';

/**
 * What a line is doing, as the filter chips name it. A line may be several at once (running on
 * an older commit while its newest commit failed); `other` is for the lines that are none of the
 * rest, so that every line can be reached.
 */
export type LineStatus = 'running' | 'failed' | 'waiting' | 'passed' | 'other';

export const LINE_STATUSES = [
  'running',
  'failed',
  'waiting',
  'passed',
  'other',
] as const satisfies readonly LineStatus[];

export interface StatusPresentation {
  readonly label: string;
  /** Says which lines the chip matches. */
  readonly description: string;
  readonly tone: Tone;
  /** The state whose icon the chip shows. */
  readonly icon: RunState;
}

export const STATUS_PRESENTATION: Readonly<Record<LineStatus, StatusPresentation>> = {
  running: {
    label: 'Running',
    description: 'Lines with a run in progress or queued',
    tone: 'active',
    icon: 'in_progress',
  },
  failed: {
    label: 'Failed',
    description: 'Lines whose newest commit has a failed or timed-out run',
    tone: 'failure',
    icon: 'failure',
  },
  waiting: {
    label: 'Waiting',
    description: 'Lines with a run waiting for an approval or another action',
    tone: 'attention',
    icon: 'waiting',
  },
  passed: {
    label: 'Passed',
    description: 'Lines whose newest commit passed',
    tone: 'success',
    icon: 'success',
  },
  other: {
    label: 'Other',
    description: 'Cancelled, skipped, neutral, stale or unknown lines',
    tone: 'muted',
    icon: 'cancelled',
  },
};

/** The statuses of a line; never empty. */
export function lineStatuses(line: LineView): ReadonlySet<LineStatus> {
  const statuses = new Set<LineStatus>();
  if (line.runs.some((run) => run.state === 'in_progress' || run.state === 'queued')) {
    statuses.add('running');
  }
  if (line.failed > 0) {
    statuses.add('failed');
  }
  if (line.runs.some((run) => run.state === 'waiting' || run.state === 'action_required')) {
    statuses.add('waiting');
  }
  if (line.commitState === 'success') {
    statuses.add('passed');
  }
  if (statuses.size === 0) {
    statuses.add('other');
  }
  return statuses;
}

/** Whether `line` shows under `selected`: any chip it matches, or every line when none is. */
export function matchesFilter(line: LineView, selected: ReadonlySet<LineStatus>): boolean {
  if (selected.size === 0) {
    return true;
  }
  for (const status of lineStatuses(line)) {
    if (selected.has(status)) {
      return true;
    }
  }
  return false;
}

/** The repositories with only their lines that match; those left without a line are dropped. */
export function filterRepositories(
  repositories: readonly RepositoryView[],
  selected: ReadonlySet<LineStatus>,
): readonly RepositoryView[] {
  if (selected.size === 0) {
    return repositories;
  }
  return repositories.flatMap((repository) => {
    const lines = repository.lines.filter((line) => matchesFilter(line, selected));
    return lines.length > 0 ? [{ ...repository, lines }] : [];
  });
}

/** Number of lines of each status; a line counts once under each of its statuses. */
export function countStatuses(
  repositories: readonly RepositoryView[],
): Readonly<Record<LineStatus, number>> {
  const counts: Record<LineStatus, number> = {
    running: 0,
    failed: 0,
    waiting: 0,
    passed: 0,
    other: 0,
  };
  for (const repository of repositories) {
    for (const line of repository.lines) {
      for (const status of lineStatuses(line)) {
        counts[status] += 1;
      }
    }
  }
  return counts;
}

const PARAMETER = 'status';

/** The statuses named by the `status` parameter of a query string; unknown names are ignored. */
export function readFilter(search: string): ReadonlySet<LineStatus> {
  const names = new URLSearchParams(search).getAll(PARAMETER).flatMap((value) => value.split(','));
  return new Set(LINE_STATUSES.filter((status) => names.includes(status)));
}

/** `search` with its `status` parameter set to `selected`, or removed when none is. */
export function writeFilter(search: string, selected: ReadonlySet<LineStatus>): string {
  const parameters = new URLSearchParams(search);
  const value = LINE_STATUSES.filter((status) => selected.has(status)).join(',');
  if (value === '') {
    parameters.delete(PARAMETER);
  } else {
    parameters.set(PARAMETER, value);
  }
  const query = parameters.toString().replaceAll('%2C', ',');
  return query === '' ? '' : `?${query}`;
}
