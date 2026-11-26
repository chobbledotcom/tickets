/**
 * IO shell for the no-JavaScript check: reads the paths git tracks and hands
 * them to the rule. Built bundles are not tracked, so they never count.
 */

import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { type RunCommand, runGit } from "#scripts/precommit/git.ts";
import { javascriptFindings } from "./rules.ts";

/** Every path git tracks, relative to the repository root. */
const trackedPaths = async (run: RunCommand): Promise<string[]> => {
  const listing = await runGit(run, ["ls-files", "-z"]);
  if (listing.code !== 0) {
    throw new Error(`git ls-files failed: ${listing.stderr.trim()}`);
  }
  return listing.stdout.split("\0").filter((path) => path !== "");
};

/** Check that git tracks no JavaScript file. */
export const runNoJsCheck = async (
  run: RunCommand,
  output: CheckOutput,
): Promise<number> =>
  reportCheck({
    ...output,
    found: javascriptFindings(await trackedPaths(run)),
    guide: '"Runtime Environment" in AGENTS.md',
    noun: "JavaScript file",
    success: "Every tracked source file is TypeScript.",
  });
