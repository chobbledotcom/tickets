/**
 * No alias exports — a name that is just another name for an imported one.
 *
 * The "No alias exports" rule in AGENTS.md says never export a renamed copy of
 * something another module already exports; expose the shared mechanism itself
 * instead. This module finds the mechanical shapes of that: an exported
 * `const` whose whole value is one imported name, including a member pulled
 * from one by destructuring, an `export { imported as alias }` clause, and a
 * re-export clause (`export { X as Y } from "…"`) that gives a foreign name a
 * second name. A wrapper that calls, transforms, or defaults is not an alias,
 * so a call or a literal value never flags.
 */

import {
  bindingAliases,
  type FileBindings,
  fileBindingsOf,
  type Statement,
  typeAliasTarget,
} from "#scripts/check-alias-exports/bindings.ts";
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

type ExportStatement = Extract<Statement, { type: "ExportNamedDeclaration" }>;

/** What every alias scan reads: the file's bindings plus its text. */
interface FileScan extends FileBindings {
  content: string;
}

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

/** The import target a local binding names, when it names one at all: an
 * import spelled directly (by its source module's own name when the import
 * renamed it), or a local binding that renames one. */
const targetOf = (name: string, scan: FileScan): string | null =>
  scan.importRenames.get(name) ??
  (scan.imported.has(name) ? name : undefined) ??
  scan.aliased.get(name) ??
  scan.aliasedTypes.get(name) ??
  null;

/** What an export clause hides, if anything:

- A clause on the file's own export names a local import or a local const
  alias. A directly imported name exported under its own name publishes that
  name on purpose, so only a rename counts — unless the import statement
  itself renamed it, because exporting the local then gives the source
  module's name a second name. A local const alias hides the import it copies
  under any name, its own included.
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
  const renamedByImport = scan.importRenames.has(local);
  if (scan.imported.has(local) && !renamedByImport && !isRenamed(specifier)) {
    return null;
  }
  return clauseWords(specifier, target, exportTheImportItself);
};

/** One issue: a declaration that publishes an imported thing under a second
 * name. */
const secondNameIssue = (
  scan: FileScan,
  start: number,
  exported: string,
  target: string,
): AliasExportIssue =>
  aliasIssue(scan, start, {
    exported,
    fix: exportTheImportItself(target),
    target,
  });

/** One exported declaration whose bindings the map reads, narrowed by the
 * declaration kind that reaches it. Each reader narrows itself from the
 * shared shape, because the dispatch table keys on the parser's own kind
 * names. */
type DeclaredAliasReader = (
  declaration: never,
  scan: FileScan,
) => AliasExportIssue[];

/** How one reader narrows the shared declaration shape to the kind the
 * dispatch table routed to it: pass the kind's name as the type argument. */
const declared = <T extends string>(
  node: never,
): Extract<Statement, { type: T }> =>
  node as unknown as Extract<Statement, { type: T }>;

/** Whether a declared type is a `typeof` query. */
const namesTheImportedType = (
  annotation: { typeAnnotation?: { type?: unknown } } | null | undefined,
): boolean => annotation?.typeAnnotation?.type === "TSTypeQuery";

/** An exported `const` whose whole value, or a member pulled from one by
 * destructuring, is one imported name. */
const constValueAliases: DeclaredAliasReader = (node, scan) => {
  const exported = declared<"VariableDeclaration">(node);
  // An exported `let` or `var` can be reassigned to a value of its own, so
  // its declaration alone cannot name the import for sure.
  if (exported.kind !== "const") return [];
  return exported.declarations.flatMap((declarator) => {
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
    return bindingAliases(
      declarator.id,
      declarator.init,
      scan.imported,
      scan.content,
    ).map((bound) =>
      secondNameIssue(scan, declarator.start, bound.bound, bound.target),
    );
  });
};

/** An exported `type` whose whole value is one imported name. */
const typeValueAliases: DeclaredAliasReader = (node, scan) => {
  const exported = declared<"TSTypeAliasDeclaration">(node);
  const target = typeAliasTarget(exported, scan.imported);
  if (target === null) return [];
  return [
    secondNameIssue(
      scan,
      exported.start,
      exported.id.name,
      scan.importRenames.get(target) ?? target,
    ),
  ];
};

/** The alias issues an exported declaration carries, by the declaration's
 * own kind: the consts and types a file exports under second names. */
const DECLARED_ALIASES = {
  TSTypeAliasDeclaration: typeValueAliases,
  VariableDeclaration: constValueAliases,
} as unknown as Record<string, DeclaredAliasReader>;

/** What one exported declaration's aliases are: empty for the declarations
 * the table does not read (functions, classes, and a clause-only export). */
const declaredIssues = (
  declaration: ExportStatement["declaration"],
  scan: FileScan,
): AliasExportIssue[] => {
  const read =
    declaration === null
      ? undefined
      : DECLARED_ALIASES[declaration.type as string];
  if (read === undefined) return [];
  return read(declaration as never, scan);
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
  const scan: FileScan = {
    ...fileBindingsOf(program, content),
    content,
  };
  return program.body
    .flatMap((statement) => {
      if (statement.type !== "ExportNamedDeclaration") return [];
      return [
        ...issuesOnClauses(statement, scan, (specifier) =>
          clauseHides(statement, specifier, scan),
        ),
        ...declaredIssues(statement.declaration, scan),
      ];
    })
    .sort(byLine);
};
