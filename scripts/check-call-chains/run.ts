/**
 * IO shell for the call-chain check: scans one tree and fails every chain of
 * three or more methods that repeats at two or more sites (see "Keep methods
 * flat" in AGENTS.md). Kept thin so the logic stays testable.
 */

import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import {
  collectFromFiles,
  collectGateScriptFiles,
} from "#scripts/walk-files.ts";
import { chainSitesOf, findIssues } from "./rules.ts";

/** Check the tree for a chain of three or more methods that repeats. */
export const runCallChainCheck = async (
  roots: readonly string[],
  output: CheckOutput,
): Promise<number> => {
  const sites = await collectFromFiles(
    roots,
    collectGateScriptFiles,
    chainSitesOf,
  );
  return reportCheck({
    ...output,
    found: findIssues(sites)
      .map((finding) => formatFinding(finding.where, finding))
      .sort(),
    guide: '"Keep methods flat" in AGENTS.md',
    noun: "repeated chain",
    success: "No chain of three or more methods repeats at another site.",
  });
};
