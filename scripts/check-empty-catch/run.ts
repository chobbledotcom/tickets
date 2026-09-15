/**
 * IO shell for the empty-catch checks: runs a per-file rule over the source
 * trees (see the Offensive Programming rules in AGENTS.md). Kept thin so the
 * logic stays testable.
 */

/* jscpd:ignore-start -- imports */
import { perFileCheck } from "#scripts/check-runner.ts";
import { collectGateScriptFiles } from "#scripts/walk-files.ts";
import { findIssues } from "./rules.ts";
/* jscpd:ignore-end */

/** Check every source tree for an empty catch. */
export const runEmptyCatchCheck = perFileCheck(
  collectGateScriptFiles,
  findIssues,
  {
    guide: '"Offensive Programming" in AGENTS.md',
    noun: "empty-catch",
    success: "Every catch block says what it does with the error.",
  },
);
