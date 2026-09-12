/**
 * IO shell for the Simplified Technical English checks: reads the repository
 * Markdown, skips the record documents on the exemption list, and compares
 * the rest against the pure rules in `rules.ts`. Kept thin so the logic
 * stays testable.
 *
 * The STE guide applies to the text you write or rewrite, so the check holds
 * a per-document baseline of the findings each policy document carries today,
 * recorded per finding identity — the rule, the match, and the prose of the
 * line it sits on. Each identity's count only falls: fix a document's prose,
 * then run `deno task check:ste --update` to record the step. A finding that
 * gained occurrences never reads its old allowance back, and an allowance
 * cannot move to new prose, because new prose carries a new identity.
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

/**
 * The finding identity the baseline records: the rule, what it matched, and
 * the prose of the line the match sits on. Line numbers shift when somebody
 * edits a paragraph above, but the context stays until that exact text is
 * edited — so an allowance cannot move to new prose, only fall away.
 */
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

/**
 * Compare every document against its baseline, finding by finding. An
 * identity above its recorded count reports that finding. An entry that now
 * counts fewer asks for the baseline to record the step, so an improvement
 * lands together with its ratchet step. A records entry or a baseline entry
 * whose document no longer exists fails, because both lists only shrink. Logs
 * a line per finding (or a success line) and returns the process exit code.
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
  const issues = findIssues(file.content);
  const current = countsByIdentity(issues);
  if (countsRose(recorded, current)) {
    return fileFindingLines(
      file.path,
      issues.filter(
        // An identity the record never held counts as zero on its side.
        (issue) =>
          (current[identityOf(issue)] ?? 0) >
          (recorded[identityOf(issue)] ?? 0),
      ),
    );
  }
  const shrank = Object.entries(recorded).some(
    ([identity, count]) => count > (current[identity] ?? 0),
  );
  if (!shrank) return [];
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
