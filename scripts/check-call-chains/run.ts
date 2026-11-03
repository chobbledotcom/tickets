/**
 * IO shell for the call-chain check: scans one tree and holds every repeated
 * chain of three or more methods to its recorded site count (see "Keep
 * methods flat" in AGENTS.md). Kept thin so the logic stays testable.
 */

import { formatFinding, reportCheck } from "#scripts/check-report.ts";
import type { Counts, CountsCheck } from "#scripts/check-runner.ts";
import {
  collectFromFiles,
  collectGateScriptFiles,
} from "#scripts/walk-files.ts";
import { chainSitesOf, countBySignature, findIssues } from "./rules.ts";

/** Every chain the tree repeats at two or more sites, with its site count. */
export const repeatedChains = async (
  roots: readonly string[],
): Promise<Counts> =>
  countBySignature(
    await collectFromFiles(roots, collectGateScriptFiles, chainSitesOf),
  );

/** Check the tree for a repeated chain past its recorded site count. */
export const runCallChainCheck: CountsCheck = async (
  roots,
  accepted,
  output,
) => {
  const sites = await collectFromFiles(
    roots,
    collectGateScriptFiles,
    chainSitesOf,
  );
  return reportCheck({
    ...output,
    found: findIssues(sites, accepted)
      .map((finding) => formatFinding(finding.where, finding))
      .sort(),
    guide: '"Keep methods flat" in AGENTS.md',
    noun: "repeated chain",
    success:
      "No chain of three or more methods repeats more often than its recorded count.",
  });
};
