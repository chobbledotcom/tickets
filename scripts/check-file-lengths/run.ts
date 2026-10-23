/**
 * IO shell for the file-length checks: runs a per-file rule over the source
 * trees (see "Keep code and test files under ~400 lines" in AGENTS.md). Kept
 * thin so the logic stays testable.
 */

import { registryCheck } from "#scripts/check-runner.ts";
import { collectFromFiles, collectGateFiles } from "#scripts/walk-files.ts";
import { countLines, findIssues, LINE_LIMIT, type OverLimit } from "./rules.ts";

/** Check every source file for a file over the limit, against the accepted
 * list. */
export const runFileLengthCheck = registryCheck(
  collectGateFiles,
  (file, content, accepted) => findIssues(file, content, LINE_LIMIT, accepted),
  "scripts/check-file-lengths/over-limit.json",
  {
    guide: '"Keep code and test files under ~400 lines" in AGENTS.md',
    noun: "file-length",
    success:
      "Every source file sits at or under the limit its list holds it to.",
  },
);

/** Every file over the limit with the count it holds now, for lowering the
 * accepted list. */
export const filesOverLimit = async (
  roots: readonly string[],
): Promise<OverLimit> => {
  const over = await collectFromFiles(
    roots,
    collectGateFiles,
    (file, content) => {
      const lines = countLines(content);
      return lines > LINE_LIMIT ? [[file, lines] as const] : [];
    },
  );
  return Object.fromEntries(over);
};
