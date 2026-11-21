/**
 * IO shell for the test-internals branch ratchet: read the registry from the
 * working tree and from the merge base on `origin/main`, then compare them
 * (see "Keep tests on the public surface" in AGENTS.md).
 */

import * as v from "valibot";
import type { CheckOutput } from "#scripts/check-report.ts";
import {
  COUNTS_SCHEMA,
  type Counts,
  reportFound,
} from "#scripts/check-runner.ts";
import { fileAtRevision } from "#scripts/file-at-revision.ts";
import { mergeBaseOrThrow, type RunCommand } from "#scripts/precommit/git.ts";
import { RATCHET_GUIDE, ratchetFindings } from "./ratchet.ts";
import { REGISTRY_PATH } from "./run.ts";

/** What one ratchet run reads: the working registry text, the git runner
 * that finds the merge base, and where the report goes. */
export interface RatchetInput {
  output: CheckOutput;
  readRegistryText: () => Promise<string>;
  run: RunCommand;
}

const parseCounts = (text: string): Counts =>
  v.parse(COUNTS_SCHEMA, JSON.parse(text));

/** Compare the registry with the merge base and return the process exit code
 * with the report printed. */
export const ratchetExit = async ({
  output,
  readRegistryText,
  run,
}: RatchetInput): Promise<number> => {
  const mergeBase = await mergeBaseOrThrow(run, "test-internals ratchet");
  const baseText = await fileAtRevision(run, mergeBase, REGISTRY_PATH);
  return reportFound(
    output,
    ratchetFindings(
      baseText === undefined ? undefined : parseCounts(baseText),
      parseCounts(await readRegistryText()),
    ),
    {
      guide: RATCHET_GUIDE,
      noun: "test-internals-ratchet",
      success:
        "No test file holds more counted imports than the merge base on origin/main.",
    },
  );
};
