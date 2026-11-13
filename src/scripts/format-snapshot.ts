import type { CollectionResult } from '../github/collect.ts';
import type { LineView, Problem } from '../core/snapshot.ts';

/** Compact, human-readable rendering of a collection, for `pnpm run snapshot`. */
export function formatCollection(result: CollectionResult): string {
  const { snapshot } = result;
  const out: string[] = [
    `GitHub Actions of ${snapshot.viewer} — ${shortDate(snapshot.generatedAt)}`,
  ];

  for (const problem of snapshot.problems) {
    out.push(`! ${describeProblem(problem)}`);
  }
  for (const repository of snapshot.repositories) {
    out.push('', `${repository.fullName}  (${repository.reasons.join(', ')})`);
    for (const line of repository.lines) {
      out.push(`  ${formatLine(line)}`);
    }
  }
  if (snapshot.repositories.length === 0) {
    out.push('', '(no repository with runs to show)');
  }

  const { sent, notModified } = result.requests;
  const quotas = [result.rateLimits.core, result.rateLimits.search]
    .filter((quota) => quota !== null)
    .map(
      (quota) =>
        `${quota.resource} ${String(quota.remaining)}/${String(quota.limit)} left until ${shortDate(quota.resetAt.toISOString())}`,
    );
  out.push(
    '',
    `${String(sent)} requests (${String(notModified)} not modified, ${String(sent - notModified)} counted)` +
      (quotas.length > 0 ? ` · ${quotas.join(' · ')}` : ''),
  );
  if (result.retryAt !== null) {
    out.push(`Rate limited: retry after ${shortDate(result.retryAt.toISOString())}`);
  }
  return out.join('\n');
}

function formatLine(line: LineView): string {
  // `state` includes runs still active on older commits; say so when the newest commit differs.
  const details = [
    line.commitState === line.state ? null : `latest commit ${line.commitState}`,
    line.failed > 0 && line.commitState !== 'failure' ? `${String(line.failed)} failed` : null,
  ].filter((detail) => detail !== null);
  const state = [line.state, ...details].join(', ');
  const ref = line.pullRequest
    ? `${line.label} ${line.pullRequest.title}${line.pullRequest.draft ? ' (draft)' : ''} by ${line.pullRequest.author ?? 'unknown'}`
    : line.label;
  const author = line.commit.authorName === null ? '' : ` - ${line.commit.authorName}`;
  return `[${state}] ${ref}  ${shortDate(line.date)}  ${line.commit.title}${author}`;
}

function describeProblem(problem: Problem): string {
  switch (problem.kind) {
    case 'repository':
      return `${problem.repository}: ${problem.message}`;
    case 'rate_limited':
      return `${problem.message} Resets at ${shortDate(problem.resetAt)}.`;
    case 'other':
      return problem.message;
  }
}

/** `2026-11-13T10:00:05Z` → `2026-11-13 10:00Z`. */
function shortDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}
