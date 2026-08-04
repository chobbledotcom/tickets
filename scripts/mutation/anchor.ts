/**
 * Where a mutant sits, said in a way that survives an edit somewhere else.
 *
 * The equivalent-mutant registry used to record `path:line:column`, so any edit
 * *above* a recorded expression silently invalidated its entry — the mutant
 * stopped being suppressed and the audit failed, without the recorded
 * expression having changed at all. That happened repeatedly, and was always
 * found by a reviewer rather than by a check.
 *
 * An anchor is the name of the thing the mutant sits inside — the function,
 * method, or top-level value it belongs to — plus how many mutants of the same
 * kind sit inside that same thing before it. Adding a comment, an import, or a
 * whole unrelated function moves no anchor. Renaming the function, or adding
 * another mutant of that kind inside it, does — and both are real changes to
 * the thing being recorded.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";

/** Names of the declarations a mutant can sit inside, outermost first. */
type NamePath = readonly string[];

interface Span {
  end: number;
  start: number;
}

/** A node that might lend its name to whatever sits inside it. */
interface NamedNode {
  id?: { name?: string } | null;
  key?: { name?: string; value?: unknown } | null;
  type?: string;
}

/** The name a declaration contributes, or nothing when it is anonymous. Kept
 * to the shapes that really carry a reader-recognisable name: an anonymous
 * arrow inside a call gets its name from whatever it is assigned to instead. */
const nameOf = (node: NamedNode): string | null => {
  const named = node.id?.name ?? node.key?.name;
  if (typeof named === "string" && named !== "") return named;
  const literalKey = node.key?.value;
  return typeof literalKey === "string" && literalKey !== ""
    ? literalKey
    : null;
};

/** Declarations whose name is worth carrying into the path. A block or an
 * `if` contributes nothing: naming by them would make the anchor move when
 * the surrounding code is merely re-nested. */
const NAMING_TYPES = new Set([
  "ClassDeclaration",
  "FunctionDeclaration",
  "MethodDefinition",
  "PropertyDefinition",
  "TSEnumDeclaration",
  "TSInterfaceDeclaration",
  "TSModuleDeclaration",
  "TSTypeAliasDeclaration",
  "VariableDeclarator",
]);

const isSpan = (value: unknown): value is Span =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Span).start === "number" &&
  typeof (value as Span).end === "number";

/**
 * The names enclosing byte offset `offset`, outermost first. Walks down the
 * tree following whichever child actually contains the offset, so the cost is
 * the depth of the tree rather than its size.
 */
const namePathAt = (program: object, offset: number): NamePath => {
  const names: string[] = [];
  let node: object = program;
  for (;;) {
    const record = node as Record<string, unknown>;
    if (
      typeof record.type === "string" &&
      NAMING_TYPES.has(record.type as string)
    ) {
      const named = nameOf(record as NamedNode);
      if (named !== null) names.push(named);
    }
    const next = Object.values(record)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find(
        (value) => isSpan(value) && value.start <= offset && offset < value.end,
      );
    if (!next) return names;
    node = next as object;
  }
};

/** The anchor for a mutant at `offset`, without its ordinal. Top-level code
 * belonging to no declaration anchors on the file itself, written `<file>`. */
export const anchorNameAt = (program: object, offset: number): string => {
  const names = namePathAt(program, offset);
  return names.length === 0 ? "<file>" : names.join(".");
};

export interface AnchoredMutant {
  /** `name` plus `#n` when more than one of this kind shares the name. */
  anchor: string;
  column: number;
  line: number;
  newOperator: string;
  operator: string;
}

interface HasLocation {
  column: number;
  line: number;
  newOperator: string;
  operator: string;
  start: number;
}

/**
 * Give every mutant its anchor, numbering the ones that would otherwise
 * collide. The ordinal counts only mutants sharing both the same enclosing
 * name and the same `from → to`, so adding a different kind of mutant beside a
 * recorded one leaves its number alone.
 *
 * Mutants are numbered in source order, which is the order `generateMutants`
 * produces them in for a single file.
 */
export const anchorMutants = <M extends HasLocation>(
  content: string,
  filePath: string,
  mutants: readonly M[],
): (M & AnchoredMutant)[] => {
  const fileName = filePath.split("/").pop() as string;
  const { program } = parseSync(fileName, content);
  const seen = new Map<string, number>();
  const named = mutants.map((mutant) => ({
    ...mutant,
    name: anchorNameAt(program, mutant.start),
  }));
  const totals = new Map<string, number>();
  for (const mutant of named) {
    const key = `${mutant.name} ${mutant.operator}→${mutant.newOperator}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return named.map((mutant) => {
    const key = `${mutant.name} ${mutant.operator}→${mutant.newOperator}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const { name, ...rest } = mutant;
    return {
      ...(rest as unknown as M),
      anchor: totals.get(key)! > 1 ? `${name}#${nth}` : name,
    };
  });
};
