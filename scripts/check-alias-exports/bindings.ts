/**
 * What a file's imports and local bindings name — the input half of the
 * alias-export rule. `rules.ts` reads this to decide which exports give an
 * imported thing a second name.
 */

import type { parseProgram } from "#scripts/parse-program.ts";

export type Program = ReturnType<typeof parseProgram>;
export type Statement = Program["body"][number];

/** What one file's bindings name, for the alias rule: the names its imports
 * bring in, the names an import statement renamed, and the local `const` and
 * `type` bindings whose whole value renames one of those imports. */
export interface FileBindings {
  /** A local value binding that renames an import, by the target it renames. */
  aliased: Map<string, string>;
  /** A local type alias that renames an imported type, by its target. */
  aliasedTypes: Map<string, string>;
  imported: Set<string>;
  /** Each local import name that its import statement itself renamed, by
   * the source module's own name for the same thing. */
  importRenames: Map<string, string>;
}

/** Folds every top-level statement of one kind into a Map, through what one
 * statement keeps: the shared shape behind import reading and alias
 * collection. */
const keptBy = <T extends Statement["type"]>(
  program: Program,
  kind: T,
  keepFrom: (
    statement: Extract<Statement, { type: T }>,
    keep: (key: string, value: string) => void,
  ) => void,
): Map<string, string> => {
  const kept = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== kind) continue;
    keepFrom(statement as Extract<Statement, { type: T }>, (key, value) =>
      kept.set(key, value),
    );
  }
  return kept;
};

/** One name a declaration binds, with the imported value it stands for. */
export interface BindingAlias {
  bound: string;
  target: string;
}

/** One value expression in a parsed file, as its named parts. */
type ValueNode = { name?: unknown; type?: unknown };

/** The imported name a spelling holds, when it spells one the file brought
 * in: the shared ask behind value renames and type aliases. */
export const importedNameOf = (
  name: unknown,
  imported: Set<string>,
): string | null =>
  typeof name === "string" && imported.has(name) ? name : null;

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
    return importedNameOf((value as ValueNode).name, imported);
  }
  if (node !== null && node.type === "MemberExpression") {
    const member = value as { object: unknown; end: number; start: number };
    return renamedValue(member.object, imported, content) === null
      ? null
      : content.slice(member.start, member.end);
  }
  return null;
};

/** The imported name one type alias stands for, when it stands for one at
 * all: a plain type reference to an import, with no type arguments of its
 * own. Anything else — a union, a specialization, a `typeof` — is the
 * alias's own type. */
export const typeAliasTarget = (
  statement: Extract<Statement, { type: "TSTypeAliasDeclaration" }>,
  imported: Set<string>,
): string | null => {
  const annotation = statement.typeAnnotation as {
    type?: unknown;
    typeArguments?: unknown[] | null;
    typeName?: ValueNode;
  };
  if (annotation?.type !== "TSTypeReference") return null;
  // A naked reference carries null arguments; a specialized one carries a
  // list.
  if (annotation.typeArguments !== null) return null;
  return importedNameOf(annotation.typeName?.name, imported);
};

/** One pattern a declarator can bind with, as its named parts. */
type PatternNode = {
  elements?: unknown | null;
  name?: unknown;
  properties?: unknown;
  type?: unknown;
};

/** The members one pattern binds to an imported value, spelled as that
 * value's member: `const { getIds } = byParent` binds `getIds` to
 * `byParent.getIds`, and `const [first] = pair` binds `first` to `pair[0]`.
 * A member with a default value, a rest element, a computed key, or a nested
 * pattern adds or hides something of its own, so those names never stand for
 * the plain member. */
export const bindingAliases = (
  id: unknown,
  init: unknown,
  imported: Set<string>,
  content: string,
): BindingAlias[] => {
  const target = renamedValue(init, imported, content);
  if (target === null) return [];
  const pattern = id as PatternNode;
  if (pattern.type === "Identifier") {
    return [{ bound: pattern.name as string, target }];
  }
  if (pattern.type === "ObjectPattern") {
    const properties = pattern.properties as Array<{
      computed?: unknown;
      key?: ValueNode;
      type?: unknown;
      value?: ValueNode;
    }>;
    return properties.flatMap((property) => {
      if (property.type !== "Property" || property.computed === true) {
        return [];
      }
      const key = property.key?.name;
      const value = property.value;
      if (typeof key !== "string" || value?.type !== "Identifier") return [];
      return [{ bound: value.name as string, target: `${target}.${key}` }];
    });
  }
  // A declarator's pattern is an identifier, an object pattern, or an array
  // pattern, so what is left binds array elements.
  const elements = pattern.elements as (ValueNode | null)[];
  const bound: BindingAlias[] = [];
  elements.forEach((element, index) => {
    if (element !== null && element.type === "Identifier") {
      bound.push({
        bound: element.name as string,
        target: `${target}[${index}]`,
      });
    }
  });
  return bound;
};

/** What one file's imports bring in: every local name, and the local names
 * the import statement itself renamed, by the source module's own spelling
 * (`import { TokenEntry as CheckinEntry }` carries `CheckinEntry →
 * TokenEntry`). */
const importsOf = (
  program: Program,
): { names: Set<string>; renamed: Map<string, string> } => {
  const names = new Set<string>();
  const renamed = keptBy(program, "ImportDeclaration", (statement, keep) => {
    for (const specifier of statement.specifiers) {
      names.add(specifier.local.name);
      const sourceName = (specifier as { imported?: { name?: unknown } })
        .imported?.name;
      // A default or namespace import has no source spelling, so only a
      // named import can rename one the source module already named.
      if (
        typeof sourceName === "string" &&
        sourceName !== specifier.local.name
      ) {
        keep(specifier.local.name, sourceName);
      }
    }
  });
  return { names, renamed };
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
): Map<string, string> =>
  keptBy(program, "VariableDeclaration", (statement, keep) => {
    // A `let` or `var` binding can be reassigned to something that no longer
    // renames the import, so only a `const` keeps its target for sure.
    if (statement.kind !== "const") return;
    for (const declarator of statement.declarations) {
      for (const bound of bindingAliases(
        declarator.id,
        declarator.init,
        imported,
        content,
      )) {
        keep(bound.bound, bound.target);
      }
    }
  });

/**
 * The local `type` aliases whose whole value is one imported name, by the
 * target each renames — `type CheckinEntry = TokenEntry` carries
 * `CheckinEntry → TokenEntry`. Types cannot be reassigned, so every alias
 * holds its target for sure.
 */
const localTypeAliases = (
  program: Program,
  imported: Set<string>,
): Map<string, string> =>
  keptBy(program, "TSTypeAliasDeclaration", (statement, keep) => {
    const target = typeAliasTarget(statement, imported);
    if (target !== null) {
      keep(statement.id.name, target);
    }
  });

/** Everything the alias rule wants to know about one file's imports and local
 * bindings, read once and shared by every question the rule asks. */
export const fileBindingsOf = (
  program: Program,
  content: string,
): FileBindings => {
  const { names, renamed } = importsOf(program);
  return {
    aliased: localAliases(program, names, content),
    aliasedTypes: localTypeAliases(program, names),
    imported: names,
    importRenames: renamed,
  };
};
