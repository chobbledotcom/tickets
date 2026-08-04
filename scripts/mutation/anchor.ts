/**
 * Where a mutant sits, said so it means the same thing tomorrow.
 *
 * An anchor names the thing a mutant sits inside — the function, method, or
 * value it belongs to — and fingerprints the expression it mutates. Both parts
 * are derived from the code, so resolving an anchor is the same act as
 * verifying it: an anchor that resolves has found the expression it was
 * recorded against, not merely something in the right place.
 *
 * An anchor holds only `A-Z a-z 0-9 _ $ - . % ~ @`, so it can never contain a
 * space or the `#` that starts a registry line's comment. Any other character
 * in a name is percent-encoded.
 */

/** Characters an anchor segment may hold unencoded: the ones an identifier or
 * a kebab-case key is made of. Everything else — including the `.` that joins
 * segments, and anything that would end a registry line early — is
 * percent-encoded. */
const SAFE_IN_NAME = /[A-Za-z0-9_$-]/;

const encodeName = (name: string): string =>
  [...name]
    .map((char) =>
      SAFE_IN_NAME.test(char)
        ? char
        : [...new TextEncoder().encode(char)]
            .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
            .join(""),
    )
    .join("");

/** FNV-1a over the expression's text. Short and stable is all this needs to
 * be: it tells two expressions under one name apart, and changes when the
 * expression it was recorded against changes. */
const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(-7);
};

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

/** The name a declaration contributes, or nothing when it is anonymous. An
 * anonymous arrow inside a call takes its name from whatever it is assigned
 * to instead. */
const nameOf = (node: NamedNode): string | null => {
  const named = node.id?.name ?? node.key?.name;
  if (typeof named === "string" && named !== "") return named;
  const literalKey = node.key?.value;
  return typeof literalKey === "string" && literalKey !== ""
    ? literalKey
    : null;
};

/** Declarations whose name is worth carrying into the path. A block or an `if`
 * contributes nothing: naming by them would move the anchor when surrounding
 * code is merely re-nested. */
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

interface Descent {
  /** The span whose text is fingerprinted. */
  context: Span;
  names: string[];
}

/**
 * Walk down to a mutant's span, collecting the names enclosing it and the
 * smallest node that strictly contains it. Follows only the child holding the
 * span, so the cost is the tree's depth, not its size.
 *
 * Strictly containing is what makes the fingerprint identify this mutant and
 * nothing else. A swapped operator sits in the gap inside its own expression,
 * so that expression is chosen — `a ?? 0`, not the array it shares with its
 * neighbours. A replaced literal *is* a node, so the node one step out is
 * chosen: the expression giving that literal its meaning.
 */
const descendTo = (program: object, mutant: Span): Descent => {
  const offset = mutant.start;
  const width = mutant.end - mutant.start;
  const names: string[] = [];
  const spans: Span[] = [];
  let node: object = program;
  for (;;) {
    const record = node as Record<string, unknown>;
    if (typeof record.type === "string" && NAMING_TYPES.has(record.type)) {
      const named = nameOf(record as NamedNode);
      if (named !== null) names.push(named);
    }
    if (isSpan(record)) spans.push(record);
    const next = Object.values(record)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find(
        (value) => isSpan(value) && value.start <= offset && offset < value.end,
      );
    if (!next) break;
    node = next as object;
  }
  // The program is itself a span holding every offset, so there is always at
  // least one to fall back to.
  const containing = spans.filter((span) => span.end - span.start > width);
  return { context: containing.at(-1) ?? spans.at(-1)!, names };
};

export interface AnchoredMutant {
  /** `name~fingerprint`, plus `@n` when two mutants are indistinguishable. */
  anchor: string;
}

interface HasLocation {
  end: number;
  newOperator: string;
  operator: string;
  start: number;
}

/** Every character an anchor can hold, for callers validating one. */
export const ANCHOR_PATTERN = /^[A-Za-z0-9_$\-.%~@]+$/;

/**
 * Give every mutant its anchor.
 *
 * Two mutants collide only when they share an enclosing name, a `from → to`,
 * and character-identical expression text — genuinely indistinguishable, so
 * they take `@1`, `@2` in source order. Anything that merely moves code leaves
 * every anchor alone.
 *
 * Top-level code belonging to no declaration anchors on the file itself,
 * written `%3cfile%3e`.
 */
export const anchorMutants = <M extends HasLocation>(
  program: object,
  content: string,
  mutants: readonly M[],
): (M & AnchoredMutant)[] => {
  const described = mutants.map((mutant) => {
    const { context, names } = descendTo(program, mutant);
    const name = (names.length === 0 ? ["<file>"] : names)
      .map(encodeName)
      .join(".");
    const text = content.slice(context.start, context.end);
    return {
      ...mutant,
      base: `${name}~${fingerprint(text)}`,
    };
  });
  const totals = new Map<string, number>();
  for (const mutant of described) {
    const key = `${mutant.base} ${mutant.operator}→${mutant.newOperator}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return described.map((mutant) => {
    const key = `${mutant.base} ${mutant.operator}→${mutant.newOperator}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const { base, ...rest } = mutant;
    return {
      ...(rest as unknown as M),
      anchor: totals.get(key)! > 1 ? `${base}@${nth}` : base,
    };
  });
};
