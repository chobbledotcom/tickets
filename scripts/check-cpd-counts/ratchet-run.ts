/**
 * IO shell for the cpd counts ratchet: read the committed counts, hold the scan
 * tasks to the counts file, and compare the counts with the merge base on
 * `origin/main` (see "Code Duplication" in AGENTS.md). Kept thin so the rules
 * stay in ./counts-ratchet.ts and the entry stays a one-liner.
 */

import { join } from "node:path";
import * as v from "valibot";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { fileAtRevision } from "#scripts/file-at-revision.ts";
import { COUNTS_PATH } from "#scripts/jscpd/counts.ts";
import { mergeBaseOrThrow, type RunCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { readJsonOrThrow } from "#scripts/read-json.ts";
import {
  checkedScans,
  countsFindings,
  RATCHET_GUIDE,
} from "./counts-ratchet.ts";

/** The committed counts, read from the working tree. */
export const workingCountsText: () => Promise<string> = () =>
  Deno.readTextFile(join(projectRoot, COUNTS_PATH));

/** The repository's tasks: each name and the command it runs. */
export const repositoryTasks = async (): Promise<Record<string, string>> => {
  const config = await readJsonOrThrow(
    join(projectRoot, "deno.json"),
    v.object({ tasks: v.record(v.string(), v.string()) }),
  );
  return config.tasks;
};

/** What one ratchet run reads: the counts text, the tasks, the git runner that
 * finds the merge base, and where the report goes. */
export interface RatchetInput {
  output: CheckOutput;
  readCountsText: () => Promise<string>;
  readTasks: () => Promise<Record<string, string>>;
  run: RunCommand;
}

/** Compare the counts with the merge base and return the process exit code
 * with the report printed. */
export const ratchetExit = async ({
  output,
  readCountsText,
  readTasks,
  run,
}: RatchetInput): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "cpd counts ratchet");
  const found = countsFindings(
    await readCountsText(),
    await fileAtRevision(run, mergeBase, COUNTS_PATH),
    checkedScans(await readTasks()),
  );
  return reportCheck({
    found,
    guide: RATCHET_GUIDE,
    ...output,
    noun: "cpd-count",
    success:
      "No cpd count holds more places than the merge base on origin/main.",
  });
};
