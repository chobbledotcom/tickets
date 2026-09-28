/**
 * How a grade becomes text: one page's full report, the batch table a sweep
 * prints, and the CSV rows it can write. Everything returns lines, so the
 * caller decides where they go.
 */

import { countBy } from "#scripts/count-by.ts";
import type { CheckStatus } from "./checks.ts";
import type { PageKind } from "./extract.ts";

export interface ReportRow {
  critical: boolean;
  engine: "code" | "jev";
  goodness: number;
  label: string;
  note: string;
  status: CheckStatus;
  weight: number;
}

/** How many checks passed, warned, and failed. */
interface CheckCounts {
  FAIL: number;
  PASS: number;
  WARN: number;
}

/** What every page result carries, graded or not. */
interface PageShell {
  file: string;
  kind: PageKind;
  seconds: number;
}

/** What one page earned, once every check that applies has run. */
export interface GradedPage extends PageShell {
  checks: Record<string, ReportRow>;
  counts: CheckCounts;
  error: null;
  jev: { model: string; seconds: number; tokens?: string } | null;
  jevError: string | null;
  letter: string;
  lines: number;
  score: number;
}

/** Why one page could not be graded at all. */
export interface UngradedPage extends PageShell {
  checks: Record<string, never>;
  counts: CheckCounts;
  error: string;
  jev: null;
  jevError: null;
  letter: "E";
  lines: 0;
  score: null;
}

export type PageResult = GradedPage | UngradedPage;

const letterFor = (score: number): string =>
  score >= 90
    ? "A"
    : score >= 75
      ? "B"
      : score >= 60
        ? "C"
        : score >= 45
          ? "D"
          : "F";

/** The weighted score over every check that ran, and its letter. */
export const summarise = (
  checks: Record<string, ReportRow>,
): {
  score: number;
  letter: string;
  counts: { PASS: number; WARN: number; FAIL: number };
} => {
  const counted = Object.values(checks).filter(
    (row): row is ReportRow & { status: Exclude<CheckStatus, "SKIP"> } =>
      row.status !== "SKIP",
  );
  const totalWeight = counted.reduce((sum, row) => sum + row.weight, 0);
  const earned = counted.reduce(
    (sum, row) => sum + row.weight * row.goodness,
    0,
  );
  const score =
    totalWeight === 0 ? 0 : Math.round((100 * earned) / totalWeight);
  const counts: Record<Exclude<CheckStatus, "SKIP">, number> = {
    FAIL: 0,
    PASS: 0,
    WARN: 0,
  };
  for (const row of counted) counts[row.status]++;
  return { counts, letter: letterFor(score), score };
};

const MARKS: Record<CheckStatus, string> = {
  FAIL: "X",
  PASS: "+",
  SKIP: "-",
  WARN: "~",
};

/** The full per-check report one page prints. */
export const singleReportLines = (result: PageResult): string[] => {
  const lines = [
    `Page grader - ${result.file} (${result.kind}, ${result.lines} lines, ` +
      `${Object.keys(result.checks).length} checks)`,
    "",
  ];
  for (const row of Object.values(result.checks)) {
    const critical = row.critical && row.status === "FAIL" ? " [CRITICAL]" : "";
    lines.push(
      `  [${MARKS[row.status]}] ${row.status.padEnd(4)} ` +
        `${row.label.padEnd(46)} (${row.engine.padEnd(4)} w${row.weight}) ` +
        `${row.note}${critical}`,
    );
  }
  lines.push("");
  const counted = result.counts;
  lines.push(
    `Score: ${result.score}/100 (${result.letter}) - ` +
      `${counted.PASS} pass, ${counted.WARN} warn, ${counted.FAIL} fail`,
  );
  if (result.jev !== null) {
    lines.push(
      `Jev: model=${result.jev.model}${
        result.jev.tokens === undefined ? "" : `, ${result.jev.tokens}`
      }, ${result.jev.seconds.toFixed(2)}s`,
    );
  }
  for (const row of Object.values(result.checks)) {
    if (row.critical && row.status === "FAIL") {
      lines.push(`CRITICAL: ${row.label}: ${row.note}`);
    }
  }
  return lines;
};

export const failedCheckIds = (result: PageResult): string =>
  Object.entries(result.checks)
    .filter(([, row]) => row.status === "FAIL")
    .map(([id]) => id)
    .join(",");

/** Whether Jev judged the page, so its score counts every check. A page Jev
 * failed on is scored on the mechanical checks alone, and its score cannot
 * be compared with a complete one. */
const isComplete = (result: GradedPage): boolean => result.jevError === null;

/** Complete grades first, then pages Jev failed on, then pages that could
 * not be graded; worst score first inside each group. */
const rankOf = (result: PageResult): [group: number, score: number] => {
  if (result.score === null) return [2, 0];
  return [isComplete(result) ? 0 : 1, result.score];
};

export const worstFirst = (left: PageResult, right: PageResult): number => {
  const [leftGroup, leftScore] = rankOf(left);
  const [rightGroup, rightScore] = rankOf(right);
  return leftGroup - rightGroup || leftScore - rightScore;
};

/** One row of the batch table, graded or errored. */
const tableRow = (result: PageResult): string => {
  if (result.score === null) {
    return `${"---".padStart(5)} ${"E".padEnd(2)} ${result.kind.padEnd(9)} ${"".padEnd(
      9,
    )} ${result.file} - ${result.error.slice(0, 60)}`;
  }
  const counted = result.counts;
  const jevFailed =
    result.jevError === null
      ? ""
      : ` - Jev failed: ${result.jevError.slice(0, 60)}`;
  return (
    `${String(result.score).padStart(5)} ${result.letter.padEnd(2)} ` +
    `${result.kind.padEnd(9)} ` +
    `${`${counted.PASS}/${counted.WARN}/${counted.FAIL}`.padEnd(9)} ` +
    `${failedCheckIds(result) || "-"} ${result.file}${jevFailed}`
  );
};

export const batchReportLines = (
  results: PageResult[],
  meta: { model: string; seconds: number },
): string[] => {
  const graded = results.filter(
    (result): result is GradedPage => result.score !== null,
  );
  const errored = results.length - graded.length;
  const lines = [
    `Page grader - batch of ${results.length} (model=${meta.model})`,
    `${"Score".padStart(5)} ${"L".padEnd(2)} ${"Kind".padEnd(9)} ${"p/w/x".padEnd(
      9,
    )} Failed checks`,
    "-".repeat(100),
  ];
  for (const result of results) {
    lines.push(tableRow(result));
  }
  if (graded.length === 0) return lines;
  lines.push(...aggregateLines(graded, errored, meta.seconds));
  return lines;
};

/** The check rows across a sweep that finished at `status`. */
const rowsAt = (graded: GradedPage[], status: "FAIL" | "WARN"): ReportRow[] =>
  graded
    .flatMap((result) => Object.values(result.checks))
    .filter((row) => row.status === status);

/** The counts a sweep prints under a heading, most frequent first. */
const topCounts = (counts: Record<string, number>): string[] => {
  const entries = Object.entries(counts);
  entries.sort(([, left], [, right]) => right - left);
  return entries
    .slice(0, 10)
    .map(([label, count]) => `  x${String(count).padEnd(4)} ${label}`);
};

/** The middle score, or the mean of the two middle scores when the count is
 * even. */
const medianOf = (scores: number[]): number => {
  const sorted = scores.toSorted((left, right) => left - right);
  const middle = sorted.slice(
    Math.ceil(sorted.length / 2) - 1,
    Math.floor(sorted.length / 2) + 1,
  );
  return middle.reduce((sum, score) => sum + score, 0) / middle.length;
};

/** The median and the letter counts over complete grades, or nothing when
 * Jev failed on every page. */
const scoreSummary = (complete: GradedPage[]): string[] => {
  if (complete.length === 0) return [];
  const letters = countBy((result: PageResult) => result.letter)(complete);
  return [
    `median ${medianOf(complete.map((result) => result.score))}`,
    Object.keys(letters)
      .sort()
      .map((letter) => `${letter}:${letters[letter]}`)
      .join(" "),
  ];
};

/** The summary and failure counts a sweep prints below its table. Scores
 * summarise complete grades only. Check counts cover every graded page,
 * because each counted verdict is real either way. */
const aggregateLines = (
  graded: GradedPage[],
  errored: number,
  seconds: number,
): string[] => {
  const complete = graded.filter(isComplete);
  const failCounts = countBy((row: ReportRow) => row.label)(
    rowsAt(graded, "FAIL"),
  );
  const warnCounts = countBy((row: ReportRow) => row.label)(
    rowsAt(graded, "WARN"),
  );
  const lines = [
    "-".repeat(100),
    [
      `${complete.length} graded, ${errored} errored, ` +
        `${graded.length - complete.length} Jev failed`,
      ...scoreSummary(complete),
      `${seconds.toFixed(0)}s total`,
    ].join(" | "),
  ];
  if (Object.keys(failCounts).length > 0) {
    lines.push(
      "",
      "Most-failed checks across the batch:",
      ...topCounts(failCounts),
    );
  }
  if (Object.keys(warnCounts).length > 0) {
    lines.push(
      "",
      "Most-warned checks across the batch:",
      ...topCounts(warnCounts).slice(0, 5),
    );
  }
  return lines;
};

const csvCell = (value: string | number): string => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The CSV rows a sweep can write, header first. */
export const csvLines = (results: PageResult[]): string[] => {
  const header = [
    "score",
    "letter",
    "kind",
    "file",
    "pass",
    "warn",
    "fail",
    "failed_checks",
    "jev_error",
    "error",
  ];
  return [
    header.join(","),
    ...results.map((result) =>
      [
        result.score ?? "",
        result.letter,
        result.kind,
        result.file,
        result.counts.PASS,
        result.counts.WARN,
        result.counts.FAIL,
        failedCheckIds(result),
        result.jevError ?? "",
        result.error ?? "",
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
};
