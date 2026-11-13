/**
 * IO shell for the jscpd baseline ratchet: read every committed baseline in
 * `cfg/`, hold the scan tasks to the baselines it can read, and compare each
 * baseline with the merge base on `origin/main` (see "Code Duplication" in
 * AGENTS.md). Kept thin so the rules stay in ./baseline-ratchet.ts and the
 * entry stays a one-liner.
 */

import { join } from "node:path";
import * as v from "valibot";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { fileAtRevision, pathsAtRevision } from "#scripts/file-at-revision.ts";
import { mergeBaseOrThrow, type RunCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { readJsonOrThrow } from "#scripts/read-json.ts";
import {
  baselineFileNames,
  baselinePathsNamed,
  basePathFor,
  RATCHET_GUIDE,
  riseFindings,
  unreadBaselineFindings,
} from "./baseline-ratchet.ts";

/** The directory that holds every scan config and its committed baseline. */
const BASELINE_DIR = "cfg";

/** One baseline file the ratchet compares: its repository-root-relative path,
 * and the text the working tree holds. */
export interface BaselineFile {
  path: string;
  text: string;
}

/** The baseline files the working tree holds, in path order. */
export type BaselineReader = () => Promise<BaselineFile[]>;

/** The baseline paths the scan tasks name, in path order. */
export type NamedBaselineReader = () => Promise<string[]>;

/** Every committed jscpd baseline in `cfg/`, read from the working tree. */
export const baselineFiles: BaselineReader = async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(join(projectRoot, BASELINE_DIR))) {
    names.push(entry.name);
  }
  const reads: BaselineFile[] = [];
  for (const name of baselineFileNames(names)) {
    const path = `${BASELINE_DIR}/${name}`;
    reads.push({
      path,
      text: await Deno.readTextFile(join(projectRoot, path)),
    });
  }
  return reads;
};

/** The baseline paths the repository's `scripts/cpd.ts` tasks name. */
export const taskBaselines: NamedBaselineReader = async () => {
  const config = await readJsonOrThrow(
    join(projectRoot, "deno.json"),
    v.object({ tasks: v.record(v.string(), v.string()) }),
  );
  return baselinePathsNamed(config.tasks);
};

/** What one ratchet run reads and writes: the git runner that finds the merge
 * base, the baselines to compare, the baselines the scans name, and where the
 * report goes. */
export interface RatchetInput {
  output: CheckOutput;
  readBaselines: BaselineReader;
  readNamedBaselines: NamedBaselineReader;
  run: RunCommand;
}

/** One baseline's text at the merge base, or undefined when the base holds no
 * file with that name. */
const baseText = async (
  run: RunCommand,
  mergeBase: string,
  basePaths: readonly string[],
  headPath: string,
): Promise<string | undefined> => {
  const path = basePathFor(basePaths, headPath);
  return path === undefined
    ? undefined
    : await fileAtRevision(run, mergeBase, path);
};

/** Compare every baseline with the merge base and return the process exit
 * code with the report printed. */
export const ratchetExit = async ({
  output,
  readBaselines,
  readNamedBaselines,
  run,
}: RatchetInput): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "jscpd baseline ratchet");
  const baselines = await readBaselines();
  const found = unreadBaselineFindings(
    await readNamedBaselines(),
    baselines.map(({ path }) => path),
  );
  const basePaths = await pathsAtRevision(run, mergeBase);
  for (const { path, text } of baselines) {
    found.push(
      ...riseFindings(
        path,
        text,
        await baseText(run, mergeBase, basePaths, path),
      ),
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
