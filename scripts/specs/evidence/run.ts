import { join } from "@std/path";
import { runCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { runSpecs } from "#scripts/specs/run.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import { defineEvidenceRun } from "./execute.ts";
import { defineEvidenceCommit } from "./git.ts";
import {
  buildEvidenceBundle,
  clearEvidenceOutput,
  writeEvidenceBundle,
} from "./manifest.ts";

const evidenceCommit = defineEvidenceCommit(runCommand);

export const runEvidenceSpecs = defineEvidenceRun({
  buildBundle: buildEvidenceBundle,
  clearOutput: clearEvidenceOutput,
  commit: () => evidenceCommit(projectRoot),
  declarations: EVIDENCE_CAPTURES,
  outputDir: join(projectRoot, "reports", "evidence"),
  run: runSpecs,
  writeBundle: writeEvidenceBundle,
});
