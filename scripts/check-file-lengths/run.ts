/**
 * IO shell for the file-length checks: runs a per-file rule over the source
 * trees (see "Keep code and test files under ~400 lines" in AGENTS.md). Kept
 * thin so the logic stays testable.
 */

/* jscpd:ignore-start -- imports */
import { notCoveredBy } from "#fp";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import { fileFindingLines } from "#scripts/check-runner.ts";
import {
  collectFromFiles,
  collectGateScriptFiles,
} from "#scripts/walk-files.ts";
import { countLines, findIssues, LINE_LIMIT, type OverLimit } from "./rules.ts";
/* jscpd:ignore-end */

/** The trees whose files the check reads. */
export const SOURCE_DIRS = ["src", "test", "scripts", "cli", "e2e-payments"];

/**
 * Check every source tree for a file over the limit, against the accepted
 * list. An entry whose file the trees no longer hold is a finding too: the
 * list only shrinks, and a stale entry quietly keeps its allowance. Logs a
 * line per issue (or a success line) and returns the process exit code.
 */
export const runFileLengthCheck = (
  roots: readonly string[],
  accepted: OverLimit,
  output: CheckOutput,
): Promise<number> => {
  const paths: string[] = [];
  return collectFromFiles(roots, collectGateScriptFiles, (file, content) => {
    paths.push(file);
    return fileFindingLines(
      file,
      findIssues(file, content, LINE_LIMIT, accepted),
    );
  }).then((found) => {
    const stale = notCoveredBy(
      (path: string) => path,
      paths,
    )(Object.keys(accepted)).map((path) =>
      formatFinding(path, {
        fix: "delete the entry in scripts/check-file-lengths/over-limit.json",
        problem: "entry names a file the check no longer reads",
        rule: "stale-entry",
      }),
    );
    return reportCheck({
      ...output,
      found: [...found, ...stale].sort(),
      guide: '"Keep code and test files under ~400 lines" in AGENTS.md',
      noun: "file-length",
      success:
        "Every source file sits at or under the limit its list holds " +
        "it to.",
    });
  });
};

/** Every file over the limit with the count it holds now, for lowering the
 * accepted list. */
export const filesOverLimit = async (
  roots: readonly string[],
): Promise<OverLimit> => {
  const over = await collectFromFiles(
    roots,
    collectGateScriptFiles,
    (file, content) => {
      const lines = countLines(content);
      return lines > LINE_LIMIT ? [[file, lines] as const] : [];
    },
  );
  return Object.fromEntries(over);
};
