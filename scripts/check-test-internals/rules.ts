/**
 * Hold test files to a budget of imports from `src/` internals.
 *
 * A test that reaches the app through its public surface needs no import from
 * `src/`. The surface is the HTTP handler, the forms and the JSON API. A test
 * that imports a database module or a template function ties itself to the
 * structure of the code. This check counts those imports in each test file
 * and holds the file to its recorded count. The count only falls (see "Keep
 * tests on the public surface" in AGENTS.md).
 *
 * Free imports:
 * - a type-only import,
 * - a module that carries the `// effects: pure` line, and
 * - a module on the seam list in `./seam.ts`.
 */

import {
  dynamicImports,
  resolveSpecifierToFile,
} from "#scripts/check-effects/graph.ts";
import { type Alias, topLevelImports } from "#scripts/check-imports/rules.ts";
import {
  type Counts,
  findingsPastRecord,
  type PerFileFinding,
} from "#scripts/check-runner.ts";

/** What the rule needs to know about `src/`: how a specifier names a file,
 * which files are pure, which files tests may always import, where the
 * source tree starts, and which test trees the check leaves alone, and where the strict black-box
 * tree starts. */
export interface InternalsContext {
  aliases: Alias[];
  blackboxDir: string;
  pure: ReadonlySet<string>;
  seam: ReadonlySet<string>;
  skippedTrees: readonly string[];
  sourceRoot: string;
}

/** One counted import: the line it sits on and the `src/` file it loads. */
export interface InternalImport {
  line: number;
  target: string;
}

/** Where a reader finds the command that records a fallen count. */
const UPDATE_COMMAND = "deno task check:test-internals --update";

const REGISTRY = "scripts/check-test-internals/registry.json";

/** Whether the file belongs to the strict black-box tree. */
export const inBlackboxTree = (
  file: string,
  context: InternalsContext,
): boolean => file.startsWith(context.blackboxDir);

/** Whether one `src/` file is free to import. */
const isFree = (target: string, context: InternalsContext): boolean =>
  context.pure.has(target) || context.seam.has(target);

/** The `src/` files one test file loads at run time that are not free, once
 * each, in line order. */
export const internalImports = (
  file: string,
  content: string,
  context: InternalsContext,
): InternalImport[] => {
  const loads = [
    ...topLevelImports(file, content).filter((line) => !line.typeOnly),
    ...dynamicImports(file, content),
  ];
  const seen = new Set<string>();
  const found: InternalImport[] = [];
  for (const { line, specifier } of loads) {
    const target = resolveSpecifierToFile(specifier, file, context.aliases);
    if (target === null || !target.startsWith(context.sourceRoot)) continue;
    if (isFree(target, context) || seen.has(target)) continue;
    seen.add(target);
    found.push({ line, target });
  }
  return found.sort((a, b) => a.line - b.line);
};

/** One file's count, with files that hold none left out. */
export const internalCounts = (
  files: readonly { content: string; file: string }[],
  context: InternalsContext,
): Counts => {
  const counts: Counts = {};
  for (const { content, file } of files) {
    const count = internalImports(file, content, context).length;
    if (count > 0) counts[file] = count;
  }
  return counts;
};

const FIX =
  'drive the app through test/blackbox/driver.ts, or add the line "// effects: pure" to the module when it is pure';

/** The findings for a file in the strict tree: every counted import fails,
 * whatever the registry holds. */
const blackboxIssues = (
  imports: readonly InternalImport[],
  recorded: boolean,
): PerFileFinding[] => {
  const stale: PerFileFinding[] = recorded
    ? [
        {
          fix: `delete the entry in ${REGISTRY}`,
          line: 1,
          problem: "black-box files hold no entry",
          rule: "stale-entry",
        },
      ]
    : [];
  return [
    ...stale,
    ...imports.map((entry) => ({
      fix: "drive the app through the driver",
      line: entry.line,
      problem: `imports ${entry.target}: black-box tests use the driver only`,
      rule: "blackbox-import",
    })),
  ];
};

/** One file's findings against its recorded count. The imports past the count
 * fail, a fallen count asks for its record, and an entry for a file with no
 * counted import asks for its deletion. */
export const findIssues = (
  file: string,
  content: string,
  accepted: Counts,
  context: InternalsContext,
): PerFileFinding[] => {
  const imports = internalImports(file, content, context);
  if (inBlackboxTree(file, context))
    return blackboxIssues(imports, file in accepted);
  return findingsPastRecord(
    file,
    imports,
    accepted,
    {
      clean: "holds no import of a src module that is not pure",
      fewer: (count, recorded) =>
        `imports ${count} src modules that are not pure, fewer than the recorded ${recorded}`,
      registry: REGISTRY,
      updateCommand: UPDATE_COMMAND,
    },
    (entry) => ({
      fix: FIX,
      line: entry.line,
      problem: `imports ${entry.target}, a src module that is not pure`,
      rule: "internal-import",
    }),
  );
};
