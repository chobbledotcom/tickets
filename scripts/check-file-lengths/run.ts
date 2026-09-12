/**
 * IO shell for the file-length checks: runs the per-file rule over the source
 * trees (see "Keep code and test files under ~400 lines" in AGENTS.md). Kept
 * thin so the logic stays testable.
 */

import type { CheckOutput } from "#scripts/check-report.ts";
import { perFileCheck } from "#scripts/check-runner.ts";
import {
  collectAuthoredScriptFiles,
  collectFromFiles,
} from "#scripts/walk-files.ts";
import { countLines, findIssues, LINE_LIMIT, type OverLimit } from "./rules.ts";

/** The trees whose files the check reads. */
export const SOURCE_DIRS = ["src", "test", "scripts", "cli", "e2e-payments"];

/**
 * Check every source tree for a file over the limit, against the accepted
 * list. Logs a line per issue (or a success line) and returns the process
 * exit code.
 */
export const runFileLengthCheck = (
  roots: readonly string[],
  accepted: OverLimit,
  output: CheckOutput,
): Promise<number> =>
  perFileCheck(
    collectAuthoredScriptFiles,
    (file, content) => findIssues(file, content, LINE_LIMIT, accepted),
    {
      guide: '"Keep code and test files under ~400 lines" in AGENTS.md',
      noun: "file-length",
      success:
        "Every source file sits at or under the limit its list holds " +
        "it to.",
    },
  )(roots, output);

/** Every file over the limit with the count it holds now, for lowering the
 * accepted list. */
export const filesOverLimit = async (
  roots: readonly string[],
): Promise<OverLimit> => {
  const over = await collectFromFiles(
    roots,
    collectAuthoredScriptFiles,
    (file, content) => {
      const lines = countLines(content);
      return lines > LINE_LIMIT ? [[file, lines] as const] : [];
    },
  );
  return Object.fromEntries(over);
};
