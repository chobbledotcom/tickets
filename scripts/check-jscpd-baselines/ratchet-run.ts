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
import {
  fileAtRevision,
  pathsAtRevision,
  pathsChangedSince,
} from "#scripts/file-at-revision.ts";
import { mergeBaseOrThrow, type RunCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { readJsonOrThrow } from "#scripts/read-json.ts";
import type { NewCloneScanner } from "./base-scan.ts";
import {
  addedCloneCount,
  baselineFileNames,
  baselinePathsNamed,
  basePathFor,
  RATCHET_GUIDE,
  riseFindings,
  unreadBaselineFindings,
} from "./baseline-ratchet.ts";
import { rePairCount } from "./re-pairs.ts";

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

/** The repository's tasks: each name and the command it runs. */
export const repositoryTasks = async (): Promise<Record<string, string>> => {
  const config = await readJsonOrThrow(
    join(projectRoot, "deno.json"),
    v.object({ tasks: v.record(v.string(), v.string()) }),
  );
  return config.tasks;
};

/** The baseline paths the repository's `scripts/cpd.ts` tasks name. */
export const taskBaselines: NamedBaselineReader = async () =>
  baselinePathsNamed(await repositoryTasks());

/** What one ratchet run reads and writes: the git runner that finds the merge
 * base, the baselines to compare, the baselines the scans name, the scan that
 * finds re-paired clones, and where the report goes. */
export interface RatchetInput {
  output: CheckOutput;
  readBaselines: BaselineReader;
  readNamedBaselines: NamedBaselineReader;
  run: RunCommand;
  scanNewClones: NewCloneScanner;
}

/** What the re-pair count of one baseline reads: the merge base, the paths
 * it holds, and the scan. */
interface BaseContext {
  basePaths: readonly string[];
  mergeBase: string;
  run: RunCommand;
  scanNewClones: NewCloneScanner;
}

/** Says whether a path is the same file in the working tree as at the merge
 * base. A path that the base does not hold is a changed file. */
const unchangedSince = async ({
  basePaths,
  mergeBase,
  run,
}: BaseContext): Promise<(path: string) => boolean> => {
  const changed = new Set(await pathsChangedSince(run, mergeBase));
  const held = new Set(basePaths);
  return (path) => held.has(path) && !changed.has(path);
};

/** How many re-paired clones one baseline can accept. The scan runs only when
 * the baseline holds a clone that its merge base copy does not hold. */
const rePairsFor = async (
  context: BaseContext,
  { path, text }: BaselineFile,
  base: string | undefined,
): Promise<number> => {
  if (base === undefined || addedCloneCount(path, text, base) === 0) return 0;
  return rePairCount(
    await context.scanNewClones(path, base),
    await unchangedSince(context),
  );
};

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
  scanNewClones,
}: RatchetInput): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "jscpd baseline ratchet");
  const baselines = await readBaselines();
  const found = unreadBaselineFindings(
    await readNamedBaselines(),
    baselines.map(({ path }) => path),
  );
  const basePaths = await pathsAtRevision(run, mergeBase);
  const context = { basePaths, mergeBase, run, scanNewClones };
  for (const file of baselines) {
    const base = await baseText(run, mergeBase, basePaths, file.path);
    const rePairs = await rePairsFor(context, file, base);
    found.push(...riseFindings(file.path, file.text, base, rePairs));
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
