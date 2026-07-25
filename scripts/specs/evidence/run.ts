import { join } from "@std/path";
import { projectRoot } from "#scripts/project-root.ts";
import { runSpecs, type SpecRunSummary } from "#scripts/specs/run.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import { evidenceCommit } from "./git.ts";
import { SPEC_EVIDENCE_ENV } from "./hook.ts";
import {
  buildEvidenceBundle,
  clearEvidenceOutput,
  writeEvidenceBundle,
} from "./manifest.ts";
import {
  type EvidenceCaptureDeclaration,
  evidenceTagExpression,
  parseEvidenceDeclarations,
} from "./schema.ts";

export const runEvidenceSpecs = async (): Promise<SpecRunSummary> => {
  const outputDir = join(projectRoot, "reports", "evidence");
  const commit = await evidenceCommit(projectRoot);
  await clearEvidenceOutput(outputDir);
  let declarations: EvidenceCaptureDeclaration[] | undefined;
  return runSpecs(
    {
      reports: false,
      tags: evidenceTagExpression(EVIDENCE_CAPTURES),
    },
    undefined,
    {
      beforeRun: (catalog) => {
        declarations = parseEvidenceDeclarations(EVIDENCE_CAPTURES, catalog);
      },
      env: { [SPEC_EVIDENCE_ENV]: "1" },
      onSuccess: async (messages, catalog) => {
        if (!declarations) {
          throw new Error("Evidence declarations were not validated");
        }
        await writeEvidenceBundle(
          outputDir,
          await buildEvidenceBundle({
            catalog,
            commit,
            declarations,
            messages,
          }),
        );
      },
      parallel: 0,
    },
  );
};
