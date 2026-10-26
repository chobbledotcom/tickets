/** The IO shell of the effect check: walk a source tree, build the module
 * graph, and report every pure-listed module that reaches an effect
 * root. The tests drive this against a fixture tree with fixture
 * declarations; the entry script passes the real ones. */

import type { Alias } from "#scripts/check-imports/rules.ts";
import { readAliases } from "#scripts/check-imports/run.ts";
import {
  type CheckOutput,
  formatFinding,
  reportCheck,
} from "#scripts/check-report.ts";
import { collectFromFiles, collectSourceFiles } from "#scripts/walk-files.ts";
import {
  chainToEffect,
  type ModuleGraph,
  moduleGraph,
  resolveSpecifierToFile,
  type SourceFile,
} from "./graph.ts";

/** What one run checks: the tree, the alias table, the effect roots, and
 * the pure list. */
export interface EffectsCheck {
  readonly configPath: string;
  readonly effects: Readonly<Record<string, readonly string[]>>;
  readonly output: CheckOutput;
  readonly pureModules: readonly string[];
  readonly treeRoot: string;
}

/** Note one specifier that names no walked file. */
const reportMissing = (
  findings: string[],
  specifier: string,
  detail: { fix: string; problem: string; rule: string },
): void => {
  findings.push(formatFinding(specifier, detail));
};

/** The walked file one specifier names, or null when it names nothing
 * under the tree. */
const walkedFileOrNull = (
  specifier: string,
  check: EffectsCheck,
  aliases: Alias[],
  known: ReadonlySet<string>,
): string | null => {
  const file = resolveSpecifierToFile(specifier, check.treeRoot, aliases);
  return file !== null && known.has(file) ? file : null;
};

/** Resolve the root specifiers of every effect, or null with the failure
 * already logged. A root outside the tree would silently hold its effect
 * alone, so it stops the check instead. */
const rootFilesOrNull = (
  check: EffectsCheck,
  walkedFiles: ReadonlySet<string>,
  aliases: Alias[],
): ReadonlyMap<string, readonly string[]> | null => {
  const findings: string[] = [];
  const roots = new Map<string, readonly string[]>();
  for (const [effect, specifiers] of Object.entries(check.effects)) {
    const files: string[] = [];
    for (const specifier of specifiers) {
      const file = walkedFileOrNull(specifier, check, aliases, walkedFiles);
      if (file === null) {
        reportMissing(findings, specifier, {
          fix: "Point the effect root at a real module.",
          problem: `carries ${effect} but names no file under ${check.treeRoot}`,
          rule: "effect-roots",
        });
        continue;
      }
      files.push(file);
    }
    roots.set(effect, files);
  }
  if (findings.length > 0) {
    for (const finding of findings) check.output.logError(finding);
    return null;
  }
  return roots;
};

/** Every pure-listed module that reaches an effect root, with one chain
 * of imports per effect as evidence. */
const pureFindings = (
  check: EffectsCheck,
  graph: ModuleGraph,
  roots: ReadonlyMap<string, readonly string[]>,
  aliases: Alias[],
): string[] => {
  const known = new Set(graph.keys());
  const findings: string[] = [];
  for (const specifier of check.pureModules) {
    const file = walkedFileOrNull(specifier, check, aliases, known);
    if (file === null) {
      reportMissing(findings, specifier, {
        fix: "Remove the stale pure entry.",
        problem: "names no file under the source tree",
        rule: "pure-module",
      });
      continue;
    }
    const evidence = [...roots.entries()]
      .map(([effect, files]) => ({
        chain: chainToEffect(graph, new Set(files), file),
        effect,
      }))
      .filter(
        (held): held is { chain: readonly string[]; effect: string } =>
          held.chain !== null,
      )
      .map((held) => `${held.effect}: ${held.chain.join(" → ")}`);
    if (evidence.length === 0) continue;
    findings.push(
      formatFinding(file, {
        fix: "Split the IO shell out, or drop the pure entry.",
        problem: `reaches an effect root — ${evidence.join("; ")}`,
        rule: "pure-module",
      }),
    );
  }
  return findings;
};

/** Run the check. Returns the process exit code. */
export const runEffectsCheck = async (check: EffectsCheck): Promise<number> => {
  const aliases = await readAliases(check.configPath);
  if (aliases === null) {
    check.output.logError(
      `Cannot read the import aliases in ${check.configPath}.`,
    );
    return 1;
  }
  const files: readonly SourceFile[] = await collectFromFiles(
    [check.treeRoot],
    collectSourceFiles,
    (file, content) => [{ content, file }],
  );
  const walkedFiles = new Set(files.map((source) => source.file));
  const graph = moduleGraph(files, aliases, walkedFiles);
  const roots = rootFilesOrNull(check, walkedFiles, aliases);
  if (roots === null) return 1;
  return reportCheck({
    ...check.output,
    found: pureFindings(check, graph, roots, aliases),
    guide: '"Pure, functional" in docs/designing-systems.md',
    noun: "pure-module",
    success: `Every one of ${check.pureModules.length} pure modules stays pure.`,
  });
};
