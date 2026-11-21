/**
 * IO shell for the test-internals check: read the `src/` modules that are
 * pure, scan the test tree, and hold every test file to its recorded count
 * of imports from `src/` internals (see "Keep tests on the public surface"
 * in AGENTS.md). Kept thin so the rules stay testable.
 */

import { carriesPureMarker } from "#scripts/check-effects/effects.ts";
import { readAliases } from "#scripts/check-imports/run.ts";
import { type Counts, registryCheck } from "#scripts/check-runner.ts";
import { collectFromFiles, collectSourceFiles } from "#scripts/walk-files.ts";
import { findIssues, type InternalsContext, internalCounts } from "./rules.ts";

export const REGISTRY_PATH = "scripts/check-test-internals/registry.json";

/** Every source file of the test tree that checks the app. */
const collectTestFiles =
  (context: InternalsContext) =>
  async (root: string): Promise<string[]> =>
    (await collectSourceFiles(root)).filter(
      (file) => !context.skippedTrees.some((tree) => file.startsWith(tree)),
    );

/** Where the check reads its facts: the alias file, the root of the source
 * tree, the seam, and the test trees to leave alone. */
export interface ContextSource {
  blackboxDir: string;
  configPath: string;
  seam: readonly string[];
  skippedTrees: readonly string[];
  sourceRoot: string;
}

/** The context the rules read. A `deno.json` that cannot be read stops the
 * check, since an empty alias table would count nothing. */
export const loadContext = async ({
  blackboxDir,
  configPath,
  seam,
  skippedTrees,
  sourceRoot,
}: ContextSource): Promise<InternalsContext> => {
  const aliases = await readAliases(configPath);
  if (aliases === null) {
    throw new Error(`Cannot read the import aliases in ${configPath}.`);
  }
  const pure = await collectFromFiles(
    [sourceRoot],
    collectSourceFiles,
    (file, content) => (carriesPureMarker(content) ? [file] : []),
  );
  return {
    aliases,
    blackboxDir,
    pure: new Set(pure),
    seam: new Set(seam),
    skippedTrees,
    sourceRoot: `${sourceRoot}/`,
  };
};

/** Every test file's count, files without a counted import left out, so a
 * cleared file drops its registry entry on the next `--update`. */
export const freshCounts = async (
  roots: readonly string[],
  context: InternalsContext,
): Promise<Counts> =>
  internalCounts(
    await collectFromFiles(
      roots,
      collectTestFiles(context),
      (file, content) => [{ content, file }],
    ),
    context,
  );

/** Check every test file for imports past its recorded count. */
export const runInternalsCheck = (context: InternalsContext) =>
  registryCheck(
    collectTestFiles(context),
    (file, content, accepted) => findIssues(file, content, accepted, context),
    REGISTRY_PATH,
    {
      guide: '"Keep tests on the public surface" in AGENTS.md',
      noun: "test-internals",
      success:
        "No test file imports more src internals than its recorded count.",
    },
  );
