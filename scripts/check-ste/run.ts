/**
 * IO shell for the Simplified Technical English checks: reads the policy
 * Markdown, skips the record documents on the exemption list, and compares
 * the rest against the pure rules in `rules.ts`. Kept thin so the logic
 * stays testable.
 *
 * The STE guide applies to the text you write or rewrite, so the check
 * holds a per-document baseline of issues each policy document carries
 * today. The counts only fall: fix a document's prose, then lower its entry
 * in `baseline.json` in the same change.
 */

import { join } from "@std/path";
import { notCoveredBy } from "#fp";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import { directoryEntries } from "#scripts/walk-files.ts";
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

/** The issue count each document carried when its ratchet was last set. */
export interface Baseline {
  [path: string]: number;
}

/** One Markdown file and its content, ready to check. */
export interface DocumentFile {
  content: string;
  path: string;
}

/** The Markdown files directly inside `directory`, sorted, joined to it. */
export const markdownFilesIn = async (directory: string): Promise<string[]> =>
  (await directoryEntries(directory))
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .sort();

/** Every markdown file the check reads: at the root, plus the docs folder. */
export const readDocuments = async (
  root: string,
  docsDir: string,
): Promise<DocumentFile[]> => {
  const paths = [
    ...(await markdownFilesIn(root)),
    ...(await markdownFilesIn(docsDir)),
  ];
  const files: DocumentFile[] = [];
  for (const path of paths) {
    files.push({
      content: await Deno.readTextFile(path),
      path,
    });
  }
  return files;
};

/** One finding line in the house format. */
const issueLine = (file: DocumentFile, issue: SteIssue): string =>
  formatFinding(`${file.path}:${issue.line}`, issue);

/**
 * Compare every document against its baseline. Above the baseline, every
 * issue is a finding. Below it, one finding asks for the entry to be lowered,
 * so an improvement lands together with its ratchet step. A records entry or
 * a baseline entry whose document no longer exists fails, because both lists
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
    ...files.flatMap((file) => {
      if (records[file.path] !== undefined) return [];
      const issues = findIssues(file.content);
      const allowed = baseline[file.path] ?? 0;
      if (issues.length > allowed)
        return issues.map((issue) => issueLine(file, issue));
      if (issues.length === allowed) return [];
      return [
        formatFinding(file.path, {
          fix: "lower the entry in scripts/check-ste/baseline.json",
          problem: `${issues.length} issue(s), baseline says ${allowed}`,
          rule: "improved",
        }),
      ];
    }),
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
