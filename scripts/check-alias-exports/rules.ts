/**
 * No alias exports — a name that is just another name for an imported one.
 *
 * The "No alias exports" rule in AGENTS.md says never export a renamed copy of
 * something another module already exports; expose the shared mechanism itself
 * instead. This module finds the three mechanical shapes of that: an exported
 * `const` whose whole value is one imported name, an
 * `export { imported as alias }` clause, and a re-export clause
 * (`export { X as Y } from "…"`) that gives a foreign name a second name.
 * A wrapper that calls, transforms, or defaults is not an alias, so a call or
 * a literal value never flags.
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
    // A `let` or `var` binding can be reassigned to something that no longer
    // renames the import, so only a `const` keeps its target for sure.
    if (statement.kind !== "const") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      const renamed = renamedValue(declarator.init, imported, content);
      if (renamed !== null) aliases.set(declarator.id.name, renamed);
    }
  }
  return aliases;
};

/** What one alias finding says, by the place it was found. */
interface AliasWords {
  exported: string;
  fix: string;
  target: string;
}

/** One alias finding, with its line taken from where it starts. */
const aliasIssue = (
  scan: FileScan,
  start: number,
  words: AliasWords,
): AliasExportIssue => ({
  exported: words.exported,
  fix: words.fix,
  line: lineColumnAt(scan.content, start).line,
  problem: `"${words.exported}" renames the imported ${words.target}`,
  rule: "alias-export",
  target: words.target,
});

/** The fix for a rename of a binding this file imported or aliased. */
const exportTheImportItself = (target: string): string =>
  `export ${target} itself, and let callers use it`;

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

/** One binder of an export clause — the clause's own `Specifier` shape. */
type Clause = ExportStatement["specifiers"][number];

/** Whether an export clause gives the binding a name it did not have. */
const isRenamed = (specifier: Clause): boolean =>
  clauseName(specifier.exported) !== clauseName(specifier.local);

/** The issues for a statement's export clauses, by what each renames. A
 * specifier that hides nothing returns null and produces no issue. */
const issuesOnClauses = (
  statement: ExportStatement,
  scan: FileScan,
  wordsFor: (specifier: Clause) => AliasWords | null,
): AliasExportIssue[] =>
  [...statement.specifiers].flatMap((specifier) => {
    const words = wordsFor(specifier);
    if (words === null) return [];
    return [aliasIssue(scan, specifier.start, words)];
  });

/** The finding words for one clause, by its target and the fix for that
 * target. */
const clauseWords = (
  specifier: Clause,
  target: string,
  fixFor: (target: string) => string,
): AliasWords => ({
  exported: clauseName(specifier.exported),
  fix: fixFor(target),
  target,
});

/** What an export clause hides, if anything:

- A clause on the file's own export names a local import or a local const
  alias. A directly imported name exported under its own name publishes that
  name on purpose, so only a rename counts. A local const alias hides the
  import it copies under any name, its own included.
- A re-export clause (`export { X as Y } from "…"`) names a foreign export.
  The value already has its own name in its own module, so a second name here
  is the same alias the rule forbids. An unrenamed re-export — publishing the
  foreign name under its own name — is a barrel passing through. */
const clauseHides = (
  statement: ExportStatement,
  specifier: Clause,
  scan: FileScan,
): AliasWords | null => {
  if (statement.source !== null) {
    if (!isRenamed(specifier)) return null;
    const keptName = (target: string) =>
      `let callers import ${target} from its own module, and drop the second name`;
    return clauseWords(specifier, clauseName(specifier.local), keptName);
  }
  const local = clauseName(specifier.local);
  const target = targetOf(local, scan);
  if (target === null) return null;
  const importedDirectly = scan.imported.has(local);
  if (importedDirectly && !isRenamed(specifier)) return null;
  return clauseWords(specifier, target, exportTheImportItself);
};

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
    return [
      aliasIssue(scan, declarator.start, {
        exported: declarator.id.name,
        fix: exportTheImportItself(renamed),
        target: renamed,
      }),
    ];
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
      return [
        ...issuesOnClauses(statement, scan, (specifier) =>
          clauseHides(statement, specifier, scan),
        ),
        ...constValueAliases(statement.declaration, scan),
      ];
    })
    .sort(byLine);
};
