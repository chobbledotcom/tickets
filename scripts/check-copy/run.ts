/**
 * IO shell for the copy checks: reads the locale JSON files and reports what
 * the pure rules in `rules.ts` flag. Kept thin so the logic stays testable.
 */

import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { type CopyEntry, findIssues, formatIssue } from "./rules.ts";

export const CATALOG_DIR = "src/locales/en";

/** Read every translatable string from a locale folder's JSON files. */
export const readCatalog = (dir: string): CopyEntry[] => {
  const entries: CopyEntry[] = [];
  for (const item of Deno.readDirSync(dir)) {
    if (!item.name.endsWith(".json")) continue;
    const parsed = JSON.parse(Deno.readTextFileSync(`${dir}/${item.name}`));
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        entries.push({ file: item.name, key, value });
      }
    }
  }
  return entries.sort((a, b) =>
    `${a.file} ${a.key}`.localeCompare(`${b.file} ${b.key}`),
  );
};

/**
 * Check every copy string in a locale folder. Logs a line per issue (or a
 * success line) and returns the process exit code: 0 when clean, 1 otherwise.
 */
export const runCopyCheck = (dir: string, output: CheckOutput): number =>
  reportCheck({
    ...output,
    found: findIssues(readCatalog(dir)).map(formatIssue),
    guide: 'the "Simple Language" section of AGENTS.md',
    noun: "simple-language",
    success: `All user-facing copy in ${dir} passes the simple-language checks.`,
  });
