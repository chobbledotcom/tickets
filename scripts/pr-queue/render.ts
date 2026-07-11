/**
 * The purely functional renderer for the PR queue report — turns
 * {@link PrSummary}[] into the grouped, coloured terminal report (or leaves
 * the JSON output to the shell). No I/O; `now` is injected so the output is
 * deterministic and testable, the pattern `src/shared/dates.ts` uses for
 * timezone.
 */

import { sort } from "#fp";
import { bold, dim, green, red, yellow } from "../precommit/colors.ts";
import type { Bucket, PrSummary } from "./types.ts";

// Inputs are already stripped of control characters by `sanitizeSummary` and the
// repo label in the shell, so the renderer can interpolate them directly.

/** Display metadata for each bucket: label, colour, and report order. */
const BUCKET_DISPLAY: Record<
  Bucket,
  { color: (s: string) => string; label: string }
> = {
  ATTENTION: { color: red, label: "NEEDS ATTENTION" },
  DRAFT: { color: dim, label: "DRAFT" },
  QUEUED: { color: bold, label: "IN MERGE QUEUE" },
  READY: { color: green, label: "READY TO MERGE" },
  WAITING: { color: yellow, label: "WAITING" },
};

/** The order buckets appear in the report (most pressing first). */
const BUCKET_ORDER: readonly Bucket[] = [
  "ATTENTION",
  "QUEUED",
  "WAITING",
  "DRAFT",
  "READY",
];

/** A PR older than this is flagged stale in the report. */
const STALE_AFTER_MS = 7 * 86_400_000;

/** "1h ago" / "3d ago" style suffix from an ISO timestamp. */
const ago = (iso: string, now: () => number): string => {
  const ms = now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
};

/** The two lines one PR contributes to the report: header + plain-language status. */
const prLines =
  (now: () => number) =>
  (s: PrSummary): string[] => {
    const stale = now() - new Date(s.updatedAt).getTime() > STALE_AFTER_MS;
    const ageTag = `${ago(s.updatedAt, now)}${stale ? ", stale" : ""}`;
    const facts = s.facts.join("; ");
    return [
      `  • #${s.number}  ${s.branch}  —  ${s.title}  ${dim(`(by ${s.author}, ${ageTag})`)}`,
      `    ${yellow(`branch ${s.branch} (PR ${s.number})`)} ${facts}.`,
    ];
  };

/** The lines for one bucket group: a coloured header, then each PR's lines. */
const groupLines =
  (now: () => number) =>
  (bucket: Bucket, summaries: PrSummary[]): string[] => {
    const display = BUCKET_DISPLAY[bucket];
    // Most recently touched first, so the active work surfaces at the top of
    // each group.
    const ordered = sort((a: PrSummary, b: PrSummary) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )(summaries);
    return [
      "",
      display.color(bold(`${display.label} (${ordered.length})`)),
      ...ordered.flatMap(prLines(now)),
    ];
  };

/**
 * Grouped, coloured, plain-language report. PRs are bucketed by who has the
 * next move; each is described as a quotable sentence a future agent can lift
 * directly, e.g. "branch foo (PR 3) is held up by merge conflicts".
 */
export const renderReport = (
  repo: string,
  summaries: PrSummary[],
  now: () => number = Date.now,
): string => {
  const byBucket = Object.groupBy(summaries, (s) => s.bucket);
  const counts = BUCKET_ORDER.map(
    (b) =>
      `${byBucket[b]?.length ?? 0} ${BUCKET_DISPLAY[b].label.toLowerCase()}`,
  ).join(", ");
  const header = bold(
    `PR queue — ${repo} — ${summaries.length} open (${counts})`,
  );
  const body =
    summaries.length === 0
      ? [green("No open pull requests. 🎉")]
      : BUCKET_ORDER.flatMap((b) => {
          const group = byBucket[b] ?? [];
          return group.length > 0 ? groupLines(now)(b, group) : [];
        });
  return [header, ...body].join("\n");
};
