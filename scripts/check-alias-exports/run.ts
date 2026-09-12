/**
 * IO shell for the alias-export checks: runs a per-file rule over the source
 * trees (see "No alias exports" in AGENTS.md). Kept thin so the logic stays
 * testable.
 */

/* jscpd:ignore-start -- imports */
import { perFileCheck } from "#scripts/check-runner.ts";
import { collectGateScriptFiles } from "#scripts/walk-files.ts";
import { findIssues } from "./rules.ts";
/* jscpd:ignore-end */

/** Check every source tree's exports for a name that only renames an import. */
export const runAliasExportCheck = perFileCheck(
  collectGateScriptFiles,
  findIssues,
  {
    guide: '"No alias exports" in AGENTS.md',
    noun: "alias-export",
    success: "Every exported name says what it names.",
  },
);
