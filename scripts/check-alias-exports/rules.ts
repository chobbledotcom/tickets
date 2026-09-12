/**
 * No alias exports — a name that is just another name for an imported one.
 *
 * The "No alias exports" rule in AGENTS.md says never export a renamed copy of
 * something another module already exports; expose the shared mechanism itself
 * instead. This module finds the two mechanical shapes of that: an exported
 * `const` whose whole value is one imported name, and an
 * `export { imported as alias }` clause. A wrapper that calls, transforms, or
 * defaults is not an alias, so a call or a literal value never flags.
 */

import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";

/** Where an alias export was found. */
export interface AliasExportIssue extends PerFileFinding {
  /** The new name the export gives the imported one. */
  exported: string;
  /** The imported name the export hides. */
  target: string;
}

type Program = ReturnType<typeof parseProgram>;
type Statement = Program["body"][number];
type ExportStatement = Extract<Statement, { type: "ExportNamedDeclaration" }>;

/** What every alias scan reads: the file's text and its imported names. */
interface FileScan {
  content: string;
  imported: Set<string>;
}

/** The local names one file imports, however they are spelled. */
export const importedNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      names.add(specifier.local.name);
    }
  }
  return names;
};

/** One alias finding, with its line taken from where it starts. */
const aliasIssue = (
  scan: FileScan,
  start: number,
  exported: string,
  target: string,
): AliasExportIssue => ({
  exported,
  fix: `export ${target} itself, and let callers use it`,
  line: lineColumnAt(scan.content, start).line,
  problem: `"${exported}" renames the imported ${target}`,
  rule: "alias-export",
  target,
});

/**
 * The name one side of an export clause goes by, however spelled: an
 * identifier (`x`) or a string (`"x-y"`).
 */
const clauseName = (
  part: ExportStatement["specifiers"][number]["exported"],
): string => {
  const identifier = part as { name?: unknown };
  if (typeof identifier.name === "string") return identifier.name;
  const literal = part as { value?: unknown };
  if (typeof literal.value === "string") return literal.value;
  throw new Error("An export clause names neither an identifier nor a string");
};

/** One value expression in a parsed file, as its named parts. */
type ValueNode = {
  name?: unknown;
  object?: unknown;
  property?: unknown;
  type?: unknown;
};

/** The name a value expression goes by, or null when it has none. */
const valueName = (value: unknown): string | null => {
  const node = value as ValueNode;
  return typeof node.name === "string" ? node.name : null;
};

/**
 * The value an exported `const` renames, when it renames one at all: a whole
 * imported name (`system`), or a member reached through one
 * (`byParent.getIds`). Anything else — a call, a literal, a local — is the
 * value's own export.
 */
const renamedValue = (value: unknown, imported: Set<string>): string | null => {
  if (value === null || typeof value !== "object") return null;
  const node = value as ValueNode;
  if (node.type === "Identifier") {
    const name = valueName(value);
    return name !== null && imported.has(name) ? name : null;
  }
  if (node.type === "MemberExpression") {
    const base = renamedValue(node.object, imported);
    const member = valueName(node.property);
    return base === null || member === null ? null : `${base}.${member}`;
  }
  return null;
};

/** A renamed export of a import: `export { imported as alias }`. */
const renamedSpecifiers = (
  statement: ExportStatement,
  scan: FileScan,
): AliasExportIssue[] =>
  [...statement.specifiers]
    .filter((specifier) => {
      const local = clauseName(specifier.local);
      return (
        clauseName(specifier.exported) !== local && scan.imported.has(local)
      );
    })
    .map((specifier) =>
      aliasIssue(
        scan,
        specifier.start,
        clauseName(specifier.exported),
        clauseName(specifier.local),
      ),
    );

/** An exported `const` whose whole value is one imported name. */
const constValueAliases = (
  declaration: ExportStatement["declaration"],
  scan: FileScan,
): AliasExportIssue[] => {
  if (declaration === null || declaration.type !== "VariableDeclaration") {
    return [];
  }
  return declaration.declarations.flatMap((declarator) => {
    if (declarator.id.type !== "Identifier") return [];
    // A declared type adds a contract — the documented "thin wrapper that
    // adds a guard is not an alias" case, so an annotated export stands.
    if (declarator.id.typeAnnotation !== null) return [];
    const renamed = renamedValue(declarator.init, scan.imported);
    if (renamed === null) return [];
    return [aliasIssue(scan, declarator.start, declarator.id.name, renamed)];
  });
};

/**
 * Every alias export in one file's content: exported names that only rename
 * an imported binding, in line order.
 */
export const findIssues = (
  file: string,
  content: string,
): AliasExportIssue[] => {
  const program = parseProgram(file, content);
  const scan: FileScan = { content, imported: importedNames(program) };
  return program.body
    .flatMap((statement) => {
      if (statement.type !== "ExportNamedDeclaration") return [];
      // A re-export (`export { … } from "…"`) publishes another module's name
      // on purpose; only a local rename of an import is an alias.
      return statement.source === null
        ? [
            ...renamedSpecifiers(statement, scan),
            ...constValueAliases(statement.declaration, scan),
          ]
        : [];
    })
    .sort(byLine);
};
