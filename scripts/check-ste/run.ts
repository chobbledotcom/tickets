/**
 * IO shell for the Simplified Technical English checks: reads the repository
 * Markdown, skips the record documents on the exemption list, and compares
 * the rest against the pure rules in `rules.ts`. Kept thin so the logic
 * stays testable.
 *
 * The STE guide applies to the text you write or rewrite, so the check holds
 * a per-document, per-rule baseline of the issues each policy document
 * carries today. Each rule's count only falls: fix a document's prose, then
 * run `deno task check:ste --update` to record the step. A rule that gained
 * findings never reads its old allowance back, so one grandfathered finding
 * cannot pay for a new one.
 */

import { join } from "@std/path";
import { notCoveredBy } from "#fp";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import { countsRose, fileFindingLines } from "#scripts/check-runner.ts";
import { collectFiles, directoryEntries } from "#scripts/walk-files.ts";
import { findIssues } from "./rules.ts";

/**
 * Documents that record how something was done or captured at a moment in
 * time — delivered plans, acceptance records, captured evidence. Their words
 * are history, not ours to rewrite now, so no rules and no baseline apply.
 * The list only shrinks: retire a document and delete its entry.
 */
export interface Records {
  [path: string]: string;
}

/** The finding count each document carries today, one number per rule. */
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

/** What the check currently finds in one document, counted per rule. */
const countsPerRule = (content: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { rule } of findIssues(content)) {
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
};

/** The baseline entry one document holds today. Rules that find nothing
 * stay out of the record. */
export const freshEntry = (content: string): Record<string, number> =>
  Object.fromEntries(
    Object.entries(countsPerRule(content)).filter(([, count]) => count > 0),
  );

/** Whether any document's any rule rose above its record. */
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

/**
 * Compare every document against its baseline, rule by rule. A rule above
 * its recorded count reports the document's every finding for that rule. A
 * rule that now finds fewer asks for the entry to be lowered, so an
 * improvement lands together with its ratchet step. A records entry or a
 * baseline entry whose document no longer exists fails, because both lists
 * only shrink. Logs a line per finding (or a success line) and returns the
 * process exit code.
 */
export const runSteCheck = (
  files: readonly DocumentFile[],
  records: Records,
  baseline: Baseline,
  output: CheckOutput,
): number => {
  const entriesNotRead = notCoveredBy((file: DocumentFile) => file.path, files);
  const staleEntry = (registry: string, fix: string) => (path: string) =>
    formatFinding(path, {
      fix,
      problem: `entry names no document the check reads (${registry})`,
      rule: "stale-entry",
    });
  const found = [
    ...files.flatMap((file) => findingsFor(file, records, baseline)),
    ...entriesNotRead(Object.keys(records)).map(
      staleEntry("records.json", "delete the entry"),
    ),
    ...entriesNotRead(Object.keys(baseline)).map(
      staleEntry("baseline.json", "delete the entry"),
    ),
  ].sort();
  return reportCheck({
    ...output,
    found,
    guide: 'the "Simplified Technical English" section of AGENTS.md',
    noun: "technical-english",
    success:
      "Every policy document passes the simplified-technical-english checks.",
  });
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
  const current = countsPerRule(file.content);
  if (countsRose(recorded, current)) {
    const offenders = rulesAbove(recorded, current);
    return fileFindingLines(
      file.path,
      findIssues(file.content).filter((issue) => offenders.has(issue.rule)),
    );
  }
  const shrank = Object.entries(recorded).some(
    ([rule, count]) => count > (current[rule] ?? 0),
  );
  if (!shrank) return [];
  return [
    formatFinding(file.path, {
      fix: "run `deno task check:ste --update` to record the step",
      problem: `fewer findings than recorded (${summaryOf(current)})`,
      rule: "improved",
    }),
  ];
};

/** The rules whose current count rose above the record. */
const rulesAbove = (
  recorded: Record<string, number>,
  current: Record<string, number>,
): Set<string> =>
  new Set(
    Object.entries(current)
      .filter(([rule, count]) => count > (recorded[rule] ?? 0))
      .map(([rule]) => rule),
  );

/** One readable list of what a document still holds, e.g. "semicolon: 12". */
const summaryOf = (counts: Record<string, number>): string => {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}: ${count}`);
  return parts.length === 0 ? "none" : parts.join(", ");
};
