import type { runSpecs, SpecRunSummary } from "#scripts/specs/run.ts";
import { SPEC_EVIDENCE_ENV } from "./hook.ts";
import type { EvidenceBundleInput } from "./manifest.ts";
import {
  type EvidenceCaptureDeclaration,
  evidenceTagExpression,
  parseEvidenceDeclarations,
} from "./schema.ts";

interface EvidenceRunDependencies<Bundle> {
  buildBundle: (input: EvidenceBundleInput) => Promise<Bundle>;
  clearOutput: (outputDir: string) => Promise<void>;
  commit: () => Promise<string>;
  declarations: readonly EvidenceCaptureDeclaration[];
  outputDir: string;
  run: typeof runSpecs;
  writeBundle: (outputDir: string, bundle: Bundle) => Promise<void>;
}

export const defineEvidenceRun =
  <Bundle>(
    dependencies: EvidenceRunDependencies<Bundle>,
  ): (() => Promise<SpecRunSummary>) =>
  async () => {
    const commit = await dependencies.commit();
    await dependencies.clearOutput(dependencies.outputDir);
    let declarations: EvidenceCaptureDeclaration[] | undefined;
    return dependencies.run(
      {
        reports: false,
        tags: evidenceTagExpression(dependencies.declarations),
      },
      undefined,
      {
        beforeRun: (catalog) => {
          declarations = parseEvidenceDeclarations(
            dependencies.declarations,
            catalog,
          );
        },
        env: { [SPEC_EVIDENCE_ENV]: "1" },
        onSuccess: async (messages, catalog) => {
          if (!declarations) {
            throw new Error("Evidence declarations were not validated");
          }
          await dependencies.writeBundle(
            dependencies.outputDir,
            await dependencies.buildBundle({
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
