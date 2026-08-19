/**
 * IO shell for the import checks: reads the alias table out of `deno.json`,
 * walks the source trees, and reports what the pure rules in `rules.ts` flag.
 */

import * as v from "valibot";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { readJsonOrNull } from "#scripts/read-json.ts";
import { collectFiles } from "#scripts/walk-files.ts";
import { type Alias, findImportIssues, formatIssue } from "./rules.ts";

/** The trees whose imports resolve through the root `deno.json` alias table. */
export const SOURCE_DIRS = ["src", "test", "scripts", "cli"];

export const CONFIG_PATH = "deno.json";

const ConfigSchema = v.object({ imports: v.record(v.string(), v.string()) });

/**
 * The `#` aliases, or null when `deno.json` is missing or malformed. A caller
 * that cannot read the aliases has nothing to check against, so it says so
 * rather than passing an empty table off as a clean run.
 */
export const readAliases = async (path: string): Promise<Alias[] | null> => {
  const config = await readJsonOrNull(path, ConfigSchema);
  if (config === null) return null;
  return Object.entries(config.imports)
    .filter(([name]) => name.startsWith("#"))
    .map(([name, target]) => ({ name, target }));
};

/**
 * Check every source tree's imports. Logs a line per issue (or a success line)
 * and returns the process exit code: 0 when clean, 1 otherwise.
 */
export const runImportCheck = async (
  configPath: string,
  roots: string[],
  output: CheckOutput,
): Promise<number> => {
  const aliases = await readAliases(configPath);
  if (aliases === null) {
    output.logError(`Cannot read the import aliases in ${configPath}.`);
    return 1;
  }
  const found: string[] = [];
  for (const root of roots) {
    const files = await collectFiles(root, (path) => /\.tsx?$/.test(path));
    for (const file of files) {
      const content = await Deno.readTextFile(file);
      for (const issue of findImportIssues(content, aliases)) {
        found.push(formatIssue(file, issue));
      }
    }
  }
  return reportCheck({
    ...output,
    found,
    guide: '"Imports name a module one way" in AGENTS.md',
    noun: "import",
    success: `Every import in ${roots.join(
      ", ",
    )} names its module once, by its shortest alias.`,
  });
};
