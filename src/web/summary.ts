// The page at a glance: the summary next to the heading, the tab title and favicon, and the
// short announcements made to assistive technology when something finishes.

import type { RepositoryView, Snapshot } from '../core/snapshot.ts';
import type { ConnectionState } from './connection.ts';
import { countStatuses } from './filter.ts';
import { STATE_PRESENTATION, type Tone } from './states.ts';

export const PAGE_TITLE = 'My GitHub Actions';

/**
 * Lines counted by what they are doing now. A line counts once per category, and may be in
 * several. What is active comes from all of a line's runs, including runs still active on an
 * older commit (the core keeps those); failures come from the newest commit only. The summary,
 * tab title and favicon all derive from this; the categories are the status filter's (`filter.ts`).
 */
export interface PageSummary {
  /** Lines with a run in progress or queued. */
  readonly running: number;
  /** Lines whose newest commit has a failed or timed-out run. */
  readonly failed: number;
  /** Lines with a run waiting for someone: an approval, or another action. */
  readonly waiting: number;
}

export function summarise(repositories: readonly RepositoryView[]): PageSummary {
  const counts = countStatuses(repositories);
  return { running: counts.running, failed: counts.failed, waiting: counts.waiting };
}

export interface SummaryPart {
  readonly text: string;
  readonly tone: Tone;
}

/** "3 running · 1 failed · 1 waiting", as parts; "Nothing running" when all is quiet. */
export function summaryParts(summary: PageSummary): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (summary.running > 0) {
    parts.push({ text: `${String(summary.running)} running`, tone: 'active' });
  }
  if (summary.failed > 0) {
    parts.push({ text: `${String(summary.failed)} failed`, tone: 'failure' });
  }
  if (summary.waiting > 0) {
    parts.push({ text: `${String(summary.waiting)} waiting`, tone: 'attention' });
  }
  return parts.length > 0 ? parts : [{ text: 'Nothing running', tone: 'muted' }];
}

/** Which favicon the tab shows (`favicon-<name>.svg`). */
export type FaviconName = 'quiet' | 'running' | 'failed' | 'offline';

/**
 * Tab title and favicon, so that a pinned tab tells what is going on. The title carries the same
 * parts as the summary on the page. For the favicon, failures win over anything active (they
 * need attention), and a lost connection over both (the rest may be out of date).
 */
export function tabState(
  summary: PageSummary,
  connection: ConnectionState,
): { readonly title: string; readonly favicon: FaviconName } {
  if (connection === 'disconnected') {
    return { title: `Disconnected · ${PAGE_TITLE}`, favicon: 'offline' };
  }
  const quiet = summary.running === 0 && summary.failed === 0 && summary.waiting === 0;
  const parts = summaryParts(summary).map((part) => part.text);
  const title = quiet ? PAGE_TITLE : `${parts.join(' · ')} · ${PAGE_TITLE}`;
  const favicon = summary.failed > 0 ? 'failed' : quiet ? 'quiet' : 'running';
  return { title, favicon };
}

/** At most this many line changes are spelled out in one announcement. */
const MAX_ANNOUNCED = 3;

/**
 * What to announce politely after a new snapshot: lines that finished ("acme/api #12 failed")
 * and lines that started failing while still running. Nothing for the first snapshot, nor for
 * lines that appear or disappear (the summary covers them). Returns "" when there is nothing
 * worth interrupting for.
 */
export function describeChanges(previous: Snapshot | null, next: Snapshot | null): string {
  if (previous === null || next === null) {
    return '';
  }
  const before = new Map(
    previous.repositories.flatMap((repository) =>
      repository.lines.map((line) => [`${repository.fullName}\n${line.key}`, line] as const),
    ),
  );
  const messages: string[] = [];
  for (const repository of next.repositories) {
    for (const line of repository.lines) {
      const old = before.get(`${repository.fullName}\n${line.key}`);
      if (old === undefined) {
        continue;
      }
      const name = `${repository.fullName} ${line.label}`;
      if (old.active && !line.active) {
        messages.push(`${name} ${STATE_PRESENTATION[line.state].phrase}`);
      } else if (line.active && old.failed === 0 && line.failed > 0) {
        messages.push(`${name}: ${String(line.failed)} failed`);
      }
    }
  }
  if (messages.length > MAX_ANNOUNCED) {
    const more = messages.length - MAX_ANNOUNCED;
    return `${messages.slice(0, MAX_ANNOUNCED).join('. ')}. And ${String(more)} more.`;
  }
  return messages.length > 0 ? `${messages.join('. ')}.` : '';
}
