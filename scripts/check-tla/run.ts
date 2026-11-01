import { relative } from "node:path";
import {
  type CheckOutput,
  consoleOutput,
  reportCheck,
} from "#scripts/check-report.ts";
import { fileFindingLines } from "#scripts/check-runner.ts";
import { assertNoSymlink, collectTlaSources } from "#scripts/tla/files.ts";
import {
  VERIFICATION_MODULES,
  verificationModuleFor,
} from "#scripts/verify-models/registry.ts";
import { findModuleIssues, findRegistryIssues } from "./rules.ts";

const report = (output: CheckOutput, found: string[]): number =>
  reportCheck({
    ...output,
    found,
    guide: "docs/model-verification.md",
    noun: "TLA standard",
    success:
      "TLA standards: every maintained model and helper has a valid declaration.",
  });

/** Read declarations and sources without loading or running a fact producer. */
export const checkVerification = async (
  output: CheckOutput = consoleOutput,
): Promise<number> => {
  const files = await collectTlaSources(["verification"]);
  const found = fileFindingLines(
    "scripts/verify-models/registry.ts",
    findRegistryIssues(VERIFICATION_MODULES, files),
  );
  if (found.length > 0) return report(output, found);
  for (const file of files) {
    const name = relative(Deno.cwd(), file);
    found.push(
      ...fileFindingLines(
        name,
        findModuleIssues(
          name,
          await Deno.readTextFile(file),
          verificationModuleFor(name),
        ),
      ),
    );
  }
  const context = new Set(
    VERIFICATION_MODULES.flatMap((entry) => entry.context),
  );
  for (const path of context) {
    await assertNoSymlink(path);
    if (!(await Deno.stat(path)).isFile)
      throw new Error(`The review context is not a source file: ${path}`);
  }
  return report(output, found);
};
