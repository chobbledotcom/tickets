import { join } from "@std/path";
import { runCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { runSpecs, type SpecRunSummary } from "#scripts/specs/run.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import { defineEvidenceRun } from "./execute.ts";
import { defineEvidenceCommit } from "./git.ts";
import {
  buildEvidenceBundle,
  clearEvidenceOutput,
  writeEvidenceBundle,
} from "./manifest.ts";
import type { EvidenceCaptureDeclaration } from "./schema.ts";
import { evidenceThemesEnv } from "./themes.ts";

const evidenceCommit = defineEvidenceCommit(runCommand);

/** One evidence run for the declarations the caller names. */
export const evidenceRunFor = (
  declarations: readonly EvidenceCaptureDeclaration[],
): (() => Promise<SpecRunSummary>) =>
  defineEvidenceRun({
    buildBundle: buildEvidenceBundle,
    clearOutput: clearEvidenceOutput,
    commit: () => evidenceCommit(projectRoot),
    declarations,
    outputDir: join(projectRoot, "reports", "evidence"),
    run: runSpecs,
    themes: evidenceThemesEnv,
    writeBundle: writeEvidenceBundle,
  });

export const runEvidenceSpecs = evidenceRunFor(EVIDENCE_CAPTURES);
