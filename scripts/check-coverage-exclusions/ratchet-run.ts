/**
 * IO shell for the coverage exclusion ratchet: diff HEAD's exclusion list
 * against the merge base on `origin/main` (see "Never add a coverage
 * exclusion" in AGENTS.md). Kept thin so the rules stay in
 * ./exclusion-ratchet.ts and the entry stays a one-liner.
 */

import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import {
  commandValue,
  type RunCommand,
  runGit,
} from "#scripts/precommit/git.ts";
import {
  EXCLUSIONS_PATH,
  exclusionFindings,
  LEGACY_PATH,
  parseExclusionEntries,
  RATCHET_GUIDE,
} from "./exclusion-ratchet.ts";

/** The text of `path` at `revision`, or undefined when the revision does not
 * hold the file. Raw output: the line parser reads the two-space indent the
 * data module keeps its entries at. */
const fileAtRevision = async (
  run: RunCommand,
  revision: string,
  path: string,
): Promise<string | undefined> => {
  const { code, stdout } = await runGit(run, ["show", `${revision}:${path}`]);
  return code === 0 ? stdout : undefined;
};

/** The exclusion entries the merge base holds: from the data module, or from
 * the gate module the list moved out of. Neither file at the base means the
 * base carried no exclusions. */
export const baseEntries = async (
  run: RunCommand,
  mergeBase: string,
): Promise<string[]> => {
  const moved = await fileAtRevision(run, mergeBase, EXCLUSIONS_PATH);
  if (moved !== undefined) return parseExclusionEntries(moved);
  const legacy = await fileAtRevision(run, mergeBase, LEGACY_PATH);
  return legacy === undefined ? [] : parseExclusionEntries(legacy);
};

/** Read HEAD's data module, diff it against the merge base, and return the
 * process exit code with the report printed. */
export const ratchetExit = async (
  run: RunCommand,
  headSource: string,
  output: CheckOutput,
): Promise<number> => {
  const mergeBase = await commandValue(run, [
    "merge-base",
    "HEAD",
    "origin/main",
  ]);
  if (mergeBase === undefined) {
    throw new Error(
      "The ratchet needs origin/main. Run git fetch origin main first.",
    );
  }
  const base = await baseEntries(run, mergeBase);
  return reportCheck({
    found: exclusionFindings(headSource, base),
    guide: RATCHET_GUIDE,
    ...output,
    noun: "added-exclusion",
    success: "The coverage exclusion list adds nothing against origin/main.",
  });
};
