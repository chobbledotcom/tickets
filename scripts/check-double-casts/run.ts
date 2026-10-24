/**
 * IO shell for the double-cast check: runs the per-file rule over the source
 * trees (see "Offensive Programming" in AGENTS.md). Kept thin so the logic
 * stays testable.
 */

import { registryCheck } from "#scripts/check-runner.ts";
import {
  collectFromFiles,
  collectGateScriptFiles,
} from "#scripts/walk-files.ts";
import { BASELINE, countDoubleCasts, findIssues } from "./rules.ts";

/** Check every source tree for `as unknown as` casts against the accepted
 * counts in the baseline. */
export const runDoubleCastsCheck = registryCheck(
  collectGateScriptFiles,
  findIssues,
  BASELINE,
  {
    guide: '"Offensive Programming" in AGENTS.md',
    noun: "double-cast",
    success:
      "No file casts through `unknown` beyond the count its baseline " +
      "entry holds.",
  },
);

/** Every file holding double casts with the count it holds now, for
 * lowering the baseline. */
export const filesWithDoubleCasts = async (
  roots: readonly string[],
): Promise<Record<string, number>> => {
  const held = await collectFromFiles(
    roots,
    collectGateScriptFiles,
    (file, content) => {
      const count = countDoubleCasts(file, content);
      return count > 0 ? [[file, count] as const] : [];
    },
  );
  return Object.fromEntries(held);
};
