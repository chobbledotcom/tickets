import { join } from "@std/path";
import { projectRoot } from "#scripts/project-root.ts";
import { runSpecs, type SpecRunSummary } from "#scripts/specs/run.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
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

const currentGitCommit = async (): Promise<string> => {
  const result = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    stderr: "piped",
    stdout: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  const commit = new TextDecoder().decode(result.stdout).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Git returned an invalid commit: ${commit}`);
  }
  return commit;
};

export const runEvidenceSpecs = async (): Promise<SpecRunSummary> => {
  const outputDir = join(projectRoot, "reports", "evidence");
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
            commit: await currentGitCommit(),
            declarations,
            messages,
          }),
        );
      },
      parallel: 0,
    },
  );
};
