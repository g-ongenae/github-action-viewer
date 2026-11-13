// The notices under the heading (stale data, configuration problems, slowed-down polling,
// problems reported by the collection) and the message shown when there are no repositories.
// Pure functions of the payload: the renderer turns them into DOM.

import type { Problem } from '../core/snapshot.ts';
import type { PagePayload } from '../server/payload.ts';
import type { ConnectionState } from './connection.ts';
import { formatAgo, formatClock, formatDuration, formatIn } from './format.ts';

/** `warning`: something the reader may want to act on; `info`: worth knowing, nothing to do. */
export type NoticeTone = 'warning' | 'info';

export interface Notice {
  /** Stable identity across renders. */
  readonly key: string;
  readonly tone: NoticeTone;
  readonly title: string;
  /** Further lines, each shown on its own. */
  readonly details: readonly string[];
  /** Whether the details are verbatim text better shown in a monospace font (file problems). */
  readonly verbatim: boolean;
}

export function collectNotices(payload: PagePayload | null, now: number): Notice[] {
  if (payload === null) {
    return [];
  }
  const { status, snapshot } = payload;
  const notices: Notice[] = [];

  if (status.config.state === 'invalid') {
    notices.push({
      key: 'config',
      tone: 'warning',
      title:
        status.config.fallback === 'last_valid'
          ? 'The configuration file has problems: the last valid configuration still applies.'
          : 'The configuration file has problems: the defaults apply.',
      details: (status.config.problems ?? '').split('\n').filter((line) => line !== ''),
      verbatim: true,
    });
  }

  if (status.stale !== null) {
    const since = formatAgo(status.stale.since, now);
    const shown =
      status.lastSuccessAt === null
        ? 'No data could be collected yet'
        : `Showing data from ${formatAgo(status.lastSuccessAt, now)}`;
    const retry =
      status.nextPollAt === null ? '' : `, next attempt ${formatIn(status.nextPollAt, now)}`;
    notices.push({
      key: 'stale',
      tone: 'warning',
      title:
        status.stale.reason === 'rate_limited'
          ? `${shown}: GitHub’s rate limit was reached.`
          : `${shown}: the latest checks failed.`,
      details: [status.stale.message, `Failing since ${since}${retry}.`],
      verbatim: false,
    });
  } else if (status.pollInterval.reason === 'rate_limited') {
    const retryAt = status.rateLimits.retryAt;
    notices.push({
      key: 'rate-limited',
      tone: 'warning',
      title: `GitHub’s rate limit was reached: the page is not refreshed until it lifts${retryAt === null ? '' : ` (${formatIn(retryAt, now)})`}.`,
      details: [],
      verbatim: false,
    });
  }

  if (status.pollInterval.reason === 'budget') {
    const core = status.rateLimits.core;
    notices.push({
      key: 'budget',
      tone: 'info',
      title: `Checking every ${formatDuration(status.pollInterval.currentSeconds)} instead of every ${formatDuration(status.pollInterval.baseSeconds)}, to save GitHub API quota.`,
      details:
        core === null
          ? []
          : [
              `${String(core.remaining)} of ${String(core.limit)} requests left until ${formatClock(core.resetAt)}.`,
            ],
      verbatim: false,
    });
  }

  for (const problem of snapshot?.problems ?? []) {
    notices.push(problemNotice(problem, now));
  }
  return notices;
}

function problemNotice(problem: Problem, now: number): Notice {
  switch (problem.kind) {
    case 'repository':
      return {
        key: `problem:repository:${problem.repository}`,
        tone: 'warning',
        title: `${problem.repository} could not be read.`,
        details: [
          problem.httpStatus === null
            ? problem.message
            : `${problem.message} (HTTP ${String(problem.httpStatus)})`,
        ],
        verbatim: false,
      };
    case 'rate_limited':
      return {
        key: 'problem:rate_limited',
        tone: 'warning',
        title: `GitHub’s rate limit was reached; it resets ${formatIn(problem.resetAt, now)}.`,
        details: [problem.message],
        verbatim: false,
      };
    case 'other':
      return {
        key: `problem:other:${problem.message}`,
        tone: 'info',
        title: problem.message,
        details: [],
        verbatim: false,
      };
  }
}

/** A run of text in the empty state; `code` is shown as code (file names, commands). */
export type Inline = string | { readonly code: string };

export interface EmptyState {
  readonly key: string;
  readonly title: string;
  readonly paragraphs: readonly (readonly Inline[])[];
}

/** What the page shows instead of repositories; null when there are repositories to show. */
export function emptyState(
  payload: PagePayload | null,
  connection: ConnectionState,
): EmptyState | null {
  if (payload === null) {
    return connection === 'disconnected'
      ? {
          key: 'unreachable',
          title: 'Cannot reach the viewer’s server.',
          paragraphs: [
            [
              'Start it with ',
              { code: 'pnpm start' },
              ' in the project’s directory. This page keeps trying and reconnects by itself.',
            ],
          ],
        }
      : { key: 'connecting', title: 'Connecting…', paragraphs: [] };
  }
  if (payload.snapshot === null) {
    return {
      key: 'first-collection',
      title: 'Waiting for the first data from GitHub…',
      paragraphs: payload.status.stale === null ? [] : [['The notice above says what went wrong.']],
    };
  }
  if (payload.snapshot.repositories.length > 0) {
    return null;
  }
  return {
    key: 'no-repositories',
    title: 'No workflow runs to show.',
    paragraphs: [
      [
        'The page watches the repositories you own, the ones listed under ',
        { code: 'maintainedRepositories' },
        ' in ',
        { code: 'config.json' },
        ', and every repository where you have an open pull request. Their default branch and your pull requests appear as soon as they have a workflow run; other branches while they run.',
      ],
      payload.status.config.state === 'missing'
        ? [
            'There is no ',
            { code: 'config.json' },
            ' yet, so the defaults apply. The README explains how to create one; changes apply as soon as the file is saved.',
          ]
        : [
            'To watch more, edit ',
            { code: 'config.json' },
            ' (see the README); changes apply as soon as the file is saved.',
          ],
    ],
  };
}
