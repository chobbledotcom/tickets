/**
 * IO shell for the re-pair rule: repeat one jscpd scan against the baseline
 * that the merge base holds, and return the clones that baseline does not
 * accept. The rule stays in ./re-pairs.ts.
 */

import { dirname, join } from "node:path";
import { withTempDir } from "#scripts/bin-tools.ts";
import type { RunCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { type NewClone, newClones, scanConfigFor } from "./re-pairs.ts";

/** The clones that the scan of `baselinePath` finds and `baseText`, the merge
 * base's copy of that baseline, does not accept. */
export type NewCloneScanner = (
  baselinePath: string,
  baseText: string,
) => Promise<NewClone[]>;

/** What one base scan needs: the path of the jscpd binary, the repository's
 * tasks, and the command runner. */
export interface BaseScanInput {
  jscpd: () => Promise<string>;
  readTasks: () => Promise<Record<string, string>>;
  run: RunCommand;
}

/** Scan with the merge base's baseline in a temporary directory beside the
 * binary, so the scan leaves the committed baseline and the usual report
 * alone. */
export const baseScanner =
  ({ jscpd, readTasks, run }: BaseScanInput): NewCloneScanner =>
  async (baselinePath, baseText) => {
    const config = scanConfigFor(await readTasks(), baselinePath);
    const binary = await jscpd();
    return await withTempDir(dirname(binary), "jscpd-base-", async (dir) => {
      const baseline = join(dir, "baseline.json");
      await Deno.writeTextFile(baseline, baseText);
      const scan = [
        binary,
        ...["--config", config],
        ...["--baseline", baseline],
        ...["--reporters", "json"],
        ...["--output", dir],
      ];
      const result = await run(scan, { cwd: projectRoot });
      if (!result.success) {
        throw new Error(
          `The jscpd scan with ${config} failed: ${result.stderr.trim()}`,
        );
      }
      const report = await Deno.readTextFile(join(dir, "jscpd-report.json"));
      return newClones(JSON.parse(report), projectRoot);
    });
  };
