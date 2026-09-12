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

/** What every alias scan reads: the file's text, its imported names, and the
 * local `const` bindings whose whole value renames one of those imports. */
interface FileScan {
  /** A local const binding that renames an import, by the target it renames. */
  aliased: Map<string, string>;
  content: string;
  imported: Set<string>;
}

/** Every top-level statement of one kind, in source order. */
const statementsOf = <T extends Statement["type"]>(
  program: Program,
  kind: T,
): Extract<Statement, { type: T }>[] =>
  program.body.filter(
    (statement): statement is Extract<Statement, { type: T }> =>
      statement.type === kind,
  );

/** The local names one file imports, however they are spelled. */
export const importedNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  for (const statement of statementsOf(program, "ImportDeclaration")) {
    for (const specifier of statement.specifiers) {
      names.add(specifier.local.name);
    }
  }
  return names;
};

/**
 * The local `const` bindings whose whole value renames an import, by the
 * target each renames — `const getChildIds = byParent.getIds` carries
 * `getChildIds → byParent.getIds`. Exporting such a binding under any name is
 * the alias the rule forbids, so the export clauses resolve through this map.
 */
const localAliases = (
  program: Program,
  imported: Set<string>,
  content: string,
): Map<string, string> => {
  const aliases = new Map<string, string>();
  for (const statement of statementsOf(program, "VariableDeclaration")) {
    for (const declarator of statement.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      const renamed = renamedValue(declarator.init, imported, content);
      if (renamed !== null) aliases.set(declarator.id.name, renamed);
    }
  }
  return aliases;
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

/** The name one side of an export clause goes by: an identifier, or the
 * string it was renamed to. Real syntax is always one of the two. */
const clauseName = (
  part: ExportStatement["specifiers"][number]["exported"],
): string => {
  const identifier = part as { name?: unknown };
  if (typeof identifier.name === "string") return identifier.name;
  const literal = part as { value?: unknown };
  return literal.value as string;
};

/** One value expression in a parsed file, as its named parts. */
type ValueNode = { name?: unknown; type?: unknown };

/**
 * The value an exported `const` renames, when it renames one at all: a whole
 * imported name (`system`), or a member reached through one
 * (`byParent.getIds`, `byParent[choice]`). A member takes its target from
 * the source text, so a computed access keeps its own spelling. Anything
 * else — a call, a literal, a local — is the value's own export.
 */
const renamedValue = (
  value: unknown,
  imported: Set<string>,
  content: string,
): string | null => {
  const node = value as ValueNode | null;
  if (node !== null && node.type === "Identifier") {
    const name = (value as ValueNode).name;
    return typeof name === "string" && imported.has(name) ? name : null;
  }
  if (node !== null && node.type === "MemberExpression") {
    const member = value as { object: unknown; end: number; start: number };
    return renamedValue(member.object, imported, content) === null
      ? null
      : content.slice(member.start, member.end);
  }
  return null;
};

/** A renamed export of an imported or aliased binding:
 * `export { imported as alias }`, `export { localAlias }`, or
 * `export { localAlias as alias }`. */
const renamedSpecifiers = (
  statement: ExportStatement,
  scan: FileScan,
): AliasExportIssue[] =>
  [...statement.specifiers].flatMap((specifier) => {
    const local = clauseName(specifier.local);
    const target = targetOf(local, scan);
    if (target === null) return [];
    // A directly imported name exported under its own name publishes that
    // name on purpose, so only a rename counts. A local const alias hides
    // the import it copies under any name, its own included.
    const aliasedName = scan.imported.has(local) === false;
    const renamedExport = clauseName(specifier.exported) !== local;
    if (!aliasedName && !renamedExport) return [];
    return [
      aliasIssue(scan, specifier.start, clauseName(specifier.exported), target),
    ];
  });

/** The import target a local binding names, when it names one at all: an
 * import spelled directly, or a local const that renames one. */
const targetOf = (name: string, scan: FileScan): string | null =>
  scan.imported.has(name) ? name : (scan.aliased.get(name) ?? null);

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
    // A declared type the value does not already carry adds a contract — the
    // documented "thin wrapper that adds a guard is not an alias" case, so an
    // annotated export like `const total: Messages = system` stands. A
    // `typeof` annotation repeats the imported value's own type, adds
    // nothing, and is still an alias.
    if (
      declarator.id.typeAnnotation !== null &&
      !namesTheImportedType(declarator.id.typeAnnotation)
    ) {
      return [];
    }
    const renamed = renamedValue(declarator.init, scan.imported, scan.content);
    if (renamed === null) return [];
    return [aliasIssue(scan, declarator.start, declarator.id.name, renamed)];
  });
};

/** Whether a declared type is a `typeof` query. */
const namesTheImportedType = (
  annotation: { typeAnnotation?: { type?: unknown } } | null | undefined,
): boolean => annotation?.typeAnnotation?.type === "TSTypeQuery";

/**
 * Every alias export in one file's content: exported names that only rename
 * an imported binding, in line order.
 */
export const findIssues = (
  file: string,
  content: string,
): AliasExportIssue[] => {
  const program = parseProgram(file, content);
  const imported = importedNames(program);
  const scan: FileScan = {
    aliased: localAliases(program, imported, content),
    content,
    imported,
  };
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
