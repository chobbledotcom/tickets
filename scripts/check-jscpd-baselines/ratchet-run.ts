/**
 * IO shell for the jscpd baseline ratchet: read every committed baseline in
 * the repository root, and compare each one with the merge base on
 * `origin/main` (see "Code Duplication" in AGENTS.md). Kept thin so the rules
 * stay in ./baseline-ratchet.ts and the entry stays a one-liner.
 */

import { join } from "node:path";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { fileAtRevision } from "#scripts/file-at-revision.ts";
import { mergeBaseOrThrow, type RunCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  baselineFileNames,
  RATCHET_GUIDE,
  riseFindings,
} from "./baseline-ratchet.ts";

/** One baseline file the ratchet compares: its repository-root-relative path,
 * and the text the working tree holds. */
export interface BaselineFile {
  path: string;
  text: string;
}

/** The baseline files the working tree holds, in path order. */
export type BaselineReader = () => Promise<BaselineFile[]>;

/** Every committed jscpd baseline in the repository root, read from the
 * working tree. */
export const baselineFiles: BaselineReader = async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(projectRoot)) names.push(entry.name);
  const reads: BaselineFile[] = [];
  for (const path of baselineFileNames(names)) {
    reads.push({
      path,
      text: await Deno.readTextFile(join(projectRoot, path)),
    });
  }
  return reads;
};

/** What one ratchet run reads and writes: the git runner that finds the merge
 * base, the baselines to compare, and where the report goes. */
export interface RatchetInput {
  output: CheckOutput;
  readBaselines: BaselineReader;
  run: RunCommand;
}

/** Compare every baseline with the merge base and return the process exit
 * code with the report printed. */
export const ratchetExit = async ({
  output,
  readBaselines,
  run,
}: RatchetInput): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "jscpd baseline ratchet");
  const found: string[] = [];
  for (const { path, text } of await readBaselines()) {
    found.push(
      ...riseFindings(path, text, await fileAtRevision(run, mergeBase, path)),
    );
  }
  return reportCheck({
    found,
    guide: RATCHET_GUIDE,
    ...output,
    noun: "jscpd-baseline",
    success:
      "No jscpd baseline holds a clone above the merge base on origin/main.",
  });
};
