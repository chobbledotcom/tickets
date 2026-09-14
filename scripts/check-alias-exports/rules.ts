import { resolveExports } from "#scripts/check-alias-exports/bindings.ts";
import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";

export interface AliasExportIssue extends PerFileFinding {
  exported: string;
  target: string;
}

/** Report second names for imports, not wrappers that add their own behaviour. */
export const findIssues = (file: string, content: string): AliasExportIssue[] =>
  resolveExports(parseProgram(file, content), content)
    .map((entry) => ({
      exported: entry.exported,
      fix: entry.foreign
        ? `let callers import ${entry.target} from its own module, and drop the second name`
        : `export ${entry.target} itself, and let callers use it`,
      line: lineColumnAt(content, entry.start).line,
      problem: `"${entry.exported}" renames the imported ${entry.target}`,
      rule: "alias-export",
      target: entry.target,
    }))
    .sort(byLine);
