/**
 * The test-quality gate's IO shell: find the test files the change touches,
 * audit them at the merge base and in the working tree, and report every weak
 * assertion a touched file carries. The entry at `../check-test-quality.ts`
 * runs this with the real git and console; tests call `gateExit` directly.
 */

/* jscpd:ignore-start -- imports */
import { unique } from "#fp";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { fileAtRevision } from "#scripts/file-at-revision.ts";
import {
  type MergeBaseListReader,
  mergeBaseOrThrow,
  type RunCommand,
  runGit,
} from "#scripts/precommit/git.ts";
import {
  auditTestContent,
  type TestQualityFinding,
} from "#scripts/test-quality-audit-model.ts";
import {
  annotationLines,
  formatGateFinding,
  partitionFindings,
  RATCHET_GUIDE,
} from "./gate.ts";

/* jscpd:ignore-end */

const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;

/** The test files the working tree changes against the merge base: tracked
 * edits plus untracked new files. The diff has no second revision, so an
 * uncommitted change a precommit run must review is included, and
 * `git ls-files` adds the files the change creates that git does not track
 * yet. */
const changedTestFiles: MergeBaseListReader = async (run, mergeBase) => {
  const diff = await runGit(run, [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    mergeBase,
    "--",
    "test",
  ]);
  if (diff.code !== 0) {
    throw new Error(
      `git diff --name-only ${mergeBase} failed: ${diff.stderr.trim()}`,
    );
  }
  const untracked = await runGit(run, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "test",
  ]);
  if (untracked.code !== 0) {
    throw new Error(`git ls-files --others failed: ${untracked.stderr.trim()}`);
  }
  return unique(
    [...diff.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(
      (path) => path !== "" && TEST_FILE_PATTERN.test(path),
    ),
  );
};

/** The audit findings for the changed files in the working tree and at the
 * merge base. */
const auditChangedFiles = async (
  run: RunCommand,
  mergeBase: string,
  changed: readonly string[],
  readHead: (path: string) => Promise<string>,
): Promise<{ base: TestQualityFinding[]; head: TestQualityFinding[] }> => {
  const head = (
    await Promise.all(
      changed.map(async (path) => auditTestContent(path, await readHead(path))),
    )
  ).flat();
  const base = (
    await Promise.all(
      changed.map(async (path) => {
        const content = await fileAtRevision(run, mergeBase, path);
        return content === undefined ? [] : auditTestContent(path, content);
      }),
    )
  ).flat();
  return { base, head };
};

/** Run the gate and return the process exit code with the report printed. */
export const gateExit = async (
  run: RunCommand,
  output: CheckOutput,
  readHead: (path: string) => Promise<string>,
): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "test quality gate");
  const changed = await changedTestFiles(run, mergeBase);
  const { base, head } = await auditChangedFiles(
    run,
    mergeBase,
    changed,
    readHead,
  );
  const { added, existing } = partitionFindings(head, base);
  for (const line of annotationLines(
    added,
    existing,
    Deno.env.get("GITHUB_ACTIONS") !== undefined,
  )) {
    output.logError(line);
  }
  return reportCheck({
    // Both kinds gate: an assertion the change adds and one the touched file
    // already carried must both leave the file before it can merge.
    found: [...added, ...existing].map(formatGateFinding),
    guide: RATCHET_GUIDE,
    ...output,
    noun: "weak-assertion",
    success:
      "The test quality gate finds no weak assertions in the test files this change touches.",
  });
};
