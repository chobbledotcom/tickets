/** Compare repository prose with its accepted findings. Each allowance can only fall. */

import { join } from "@std/path";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import { countsRose, staleEntryLines } from "#scripts/check-runner.ts";
import { collectFiles, directoryEntries } from "#scripts/walk-files.ts";
import { findIssues, type SteIssue } from "./rules.ts";

/**
 * Documents that record how something was done or captured at a moment in
 * time — delivered plans, acceptance records, captured evidence. Their words
 * are history, not ours to rewrite now, so no rules and no baseline apply.
 * The list only shrinks: retire a document and delete its entry.
 */
export interface Records {
  [path: string]: string;
}

/** The finding count each document carries today, one number per finding
 * identity. */
export type Baseline = Record<string, Record<string, number>>;

/** One Markdown file and its content, ready to check. */
export interface DocumentFile {
  content: string;
  path: string;
}

/** The trees whose Markdown the check also reads, under the root files. */
export const MARKDOWN_ROOTS = ["docs", "scripts", "cli", "e2e-payments"];

/** The Markdown files directly inside `directory`, sorted, joined to it. */
export const markdownFilesIn = async (directory: string): Promise<string[]> =>
  (await directoryEntries(directory))
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .sort();

/** Whether a walked path is Markdown the check reads: ending in `.md`, not
 * inside a hidden folder or a package folder. */
const isReadableMarkdown = (path: string): boolean =>
  path.endsWith(".md") &&
  path
    .split("/")
    .every((part) => !part.startsWith(".") && part !== "node_modules");

/**
 * The Markdown files anywhere beneath `directory`, sorted. Folders nobody
 * writes — hidden folders and package folders — are left out.
 */
export const markdownFilesUnder = (directory: string): Promise<string[]> =>
  collectFiles(directory, isReadableMarkdown);

/** Every Markdown file the check reads: the root files, plus each named tree. */
export const readDocuments = async (
  root: string,
  trees: readonly string[],
): Promise<DocumentFile[]> => {
  const paths = [
    ...(await markdownFilesIn(root)),
    ...(await Promise.all(trees.map(markdownFilesUnder))).flat(),
  ].sort();
  const files: DocumentFile[] = [];
  for (const path of paths) {
    files.push({
      content: await Deno.readTextFile(path),
      path,
    });
  }
  return files;
};

/** Source reflow preserves identity. A change to the normalized prose block does not. */
export const identityOf = (issue: SteIssue): string =>
  `${issue.rule} ${issue.problem} in ${issue.context}`;

/** Count one document's findings by identity. */
const countsByIdentity = (
  issues: readonly SteIssue[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const identity = identityOf(issue);
    counts[identity] = (counts[identity] ?? 0) + 1;
  }
  return counts;
};

/** The baseline entry one document holds today. Rules that find nothing
 * stay out of the record. */
export const freshEntry = (content: string): Record<string, number> =>
  countsByIdentity(findIssues(content));

/** Whether any document's any finding rose above its record. */
export const baselineRose = (recorded: Baseline, fresh: Baseline): boolean =>
  Object.entries(fresh).some(([path, entry]) =>
    countsRose(recorded[path] ?? {}, entry),
  );

/** The baseline every non-record document holds today. */
export const freshBaseline = async (
  documents: readonly DocumentFile[],
  records: Records,
): Promise<Baseline> =>
  Object.fromEntries(
    documents
      .filter((file) => records[file.path] === undefined)
      .map((file) => [file.path, freshEntry(file.content)]),
  );

/** Sorts documents the way a reader meets them: by path. */
const byPath = (left: DocumentFile, right: DocumentFile): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/**
 * Compare every document against its baseline, finding by finding. An
 * identity above its recorded count reports that finding. An entry that now
 * counts fewer asks for the baseline to record the step, so an improvement
 * lands together with its ratchet step. A records entry or a baseline entry
 * whose document no longer exists fails, because both lists only shrink.
 * Findings report in the order a reader reads the document. Logs a line per
 * finding (or a success line) and returns the process exit code.
 */
export const runSteCheck = (
  files: readonly DocumentFile[],
  records: Records,
  baseline: Baseline,
  output: CheckOutput,
): number => {
  const paths = files.map((file) => file.path);
  const found = [
    ...[...files]
      .sort(byPath)
      .flatMap((file) => findingsFor(file, records, baseline)),
    ...staleEntryLines(
      paths,
      Object.keys(records),
      "records.json",
      "delete the entry",
    ),
    ...staleEntryLines(
      paths,
      Object.keys(baseline),
      "baseline.json",
      "delete the entry",
    ),
  ];
  return reportCheck({
    ...output,
    found,
    guide: 'the "Simplified Technical English" section of AGENTS.md',
    noun: "technical-english",
    success:
      "Every policy document passes the simplified-technical-english checks.",
  });
};
/** One document's recorded baseline entry beside its current finding counts,
 * the pair every rise and shrink check compares. */
interface ComparedCounts {
  current: Record<string, number>;
  recorded: Record<string, number>;
}
/** The count one identity holds, zero where it holds none. */
const countOf = (counts: Record<string, number>, identity: string): number =>
  counts[identity] ?? 0;

/** Only the findings an identity holds beyond its recorded count, in order:
 * an identity allowed twice and seen three times reports one finding, not
 * three. */
const risenFindings = (
  issues: readonly SteIssue[],
  { current, recorded }: ComparedCounts,
): SteIssue[] => {
  const risen: SteIssue[] = [];
  const reportedPerIdentity = new Map<string, number>();
  for (const issue of issues) {
    const identity = identityOf(issue);
    const reported = reportedPerIdentity.get(identity) ?? 0;
    const excess = countOf(current, identity) - countOf(recorded, identity);
    if (reported < excess) {
      reportedPerIdentity.set(identity, reported + 1);
      risen.push(issue);
    }
  }
  return risen;
};

/** Whether any recorded identity count fell below its current count. */
const anyShrank = ({ current, recorded }: ComparedCounts): boolean => {
  for (const [identity, count] of Object.entries(recorded)) {
    if (count > countOf(current, identity)) return true;
  }
  return false;
};

/** One document's findings against its baseline entry, or the prompt that
 * asks for the entry to be lowered. */
const findingsFor = (
  file: DocumentFile,
  records: Records,
  baseline: Baseline,
): string[] => {
  if (records[file.path] !== undefined) return [];
  const recorded = baseline[file.path] ?? {};
  const issues = findIssues(file.content);
  const compared: ComparedCounts = {
    current: countsByIdentity(issues),
    recorded,
  };
  if (countsRose(recorded, compared.current)) {
    return risenFindings(issues, compared).map((issue) =>
      formatFinding(`${file.path}:${issue.line}:${issue.column}`, issue),
    );
  }
  if (!anyShrank(compared)) return [];
  return [
    formatFinding(file.path, {
      fix: "run `deno task check:ste --update` to record the step",
      problem: `fewer findings than recorded (${summaryOf(issues)})`,
      rule: "improved",
    }),
  ];
};

/** One readable list of what a document still holds, e.g. `";": 12`. */
const summaryOf = (issues: readonly SteIssue[]): string => {
  const parts = Object.entries(countsByIdentity(issues)).map(
    ([identity, count]) => `${identity}: ${count}`,
  );
  return parts.length === 0 ? "none" : parts.join(", ");
};
