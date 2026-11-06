/** Compare repository prose with its accepted findings. Each allowance can only fall. */

import { join } from "@std/path";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import {
  compareCounts,
  type Registry,
  staleEntryLines,
} from "#scripts/check-runner.ts";
import { countBy } from "#scripts/count-by.ts";
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
const countsByIdentity = countBy(identityOf);

/** The baseline entry one document holds today. Rules that find nothing
 * stay out of the record. */
export const freshEntry = (content: string): Record<string, number> =>
  countsByIdentity(findIssues(content));

/** The baseline every non-record document holds today. */
export const freshBaseline = async (
  documents: readonly DocumentFile[],
  records: Records,
): Promise<Registry> =>
  Object.fromEntries(
    documents
      .filter((file) => records[file.path] === undefined)
      .map((file) => [file.path, freshEntry(file.content)]),
  );

/** Sorts documents the way a reader meets them: by path. Paths are unique,
 * so the comparison never holds equal. */
const byPath = (left: DocumentFile, right: DocumentFile): number =>
  left.path < right.path ? -1 : 1;

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
  baseline: Registry,
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
/** One document's findings against its baseline entry, or the prompt that
 * asks for the entry to be lowered. */
const findingsFor = (
  file: DocumentFile,
  records: Records,
  baseline: Registry,
): string[] => {
  if (records[file.path] !== undefined) return [];
  const issues = findIssues(file.content);
  return compareCounts({
    current: countsByIdentity(issues),
    file: file.path,
    findings: issues,
    keyOf: identityOf,
    recorded: baseline[file.path] ?? {},
    updateCommand: "deno task check:ste --update",
    whereOf: (issue) => `${file.path}:${issue.line}:${issue.column}`,
  });
};
