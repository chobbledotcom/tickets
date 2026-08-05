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

import { percentEncode } from "./percent-encode.ts";

/** Characters an anchor segment may hold unencoded: the ones an identifier or
 * a kebab-case key is made of. Everything else — including the `.` that joins
 * segments, and anything that would end a registry line early — is
 * percent-encoded. */
const SAFE_IN_NAME = /[A-Za-z0-9_$-]/;

const encodeName = (name: string): string =>
  [...name]
    .map((char) => (SAFE_IN_NAME.test(char) ? char : percentEncode(char)))
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

/** Whatever a node writes its name in: a declaration's `id`, a member's `key`,
 * a defaulted parameter's or an assignment's `left`, a JSX prop's `name`, a
 * switch case's `test`. */
interface Label {
  name?: string;
  type?: string;
  value?: unknown;
}

/** A node that might lend its name to whatever sits inside it. */
interface NamedNode {
  id?: Label | null;
  key?: Label | null;
  kind?: string;
  left?: Label | null;
  name?: Label | null;
  static?: boolean;
  test?: Label | null;
}

/** The name a declaration contributes, or nothing when it is anonymous. An
 * anonymous arrow inside a call takes its name from whatever it is assigned
 * to instead. A written-out key counts whether it reads as a word, a quoted
 * string, or a number — `{ 1: … }` names its member just as `{ a: … }` does,
 * and `{ "": … }` names its own, empty though that name is: dropping it would
 * put the member back in with everything unnamed, to be told apart by order.
 * A `default:` case writes no name of its own, so it contributes none. A
 * private member keeps its `#`, because one class may hold `#read` and `read`
 * and the bare name is the same for both. */
const nameOf = (node: NamedNode): string | null => {
  const label = node.id ?? node.key ?? node.left ?? node.name ?? node.test;
  if (typeof label?.name === "string" && label.name !== "") {
    return label.type === "PrivateIdentifier" ? `#${label.name}` : label.name;
  }
  const written = label?.value;
  if (typeof written === "number") return String(written);
  return typeof written === "string" ? written : null;
};

/** Which nodes may take their name from how it is written, and where the
 * writing sits. A computed key `[Kind.Text]`, a case label `case Kind.Text:`,
 * an assignment target `handlers.text = …`, a namespaced JSX prop — each picks
 * out its member or arm just as a plain name does.
 *
 * `AssignmentPattern` is missing on purpose, though it too has a `left`: a
 * binding pattern is not a name, and naming a destructured parameter by its
 * text would move the anchor whenever an unrelated field joined it. */
const WRITTEN_NAME: Record<string, "key" | "left" | "name" | "test"> = {
  AssignmentExpression: "left",
  JSXAttribute: "name",
  MethodDefinition: "key",
  Property: "key",
  PropertyDefinition: "key",
  SwitchCase: "test",
};

const writtenAs = (
  node: NamedNode,
  kind: string,
  source: string,
): string | null => {
  const field = WRITTEN_NAME[kind];
  const label = field === undefined ? null : node[field];
  return isSpan(label) ? source.slice(label.start, label.end) : null;
};

/** What a member is besides its name: which side of its class it sits on, and
 * whether it reads or writes. One class may hold `static read` and `read`, or
 * `get value` and `set value`, each taking a different type — and what a
 * fingerprint covers is the mutated expression, not the whole body, so `x ??
 * ""` in a getter and `x ?? ""` in its setter are the same text. The key alone
 * would leave those to be told apart by order. Each marker is written the way
 * `<file>` is, for the same reason: it says something no name can. */
const markersOn = (node: NamedNode): string[] => [
  ...(node.static === true ? ["<static>"] : []),
  ...(node.kind === "get" || node.kind === "set" ? [`<${node.kind}>`] : []),
];

/** The names a node adds to the path: what it is, then what it is called. */
const namesOf = (node: NamedNode, kind: string, source: string): string[] => {
  const own = nameOf(node) ?? writtenAs(node, kind, source);
  return own === null ? [] : [...markersOn(node), own];
};

/** Declarations whose name is worth carrying into the path. A block or an `if`
 * contributes nothing: naming by them would move the anchor when surrounding
 * code is merely re-nested. `Property` earns its place because so much of this
 * codebase is config objects and dispatch maps — without it, two callbacks in
 * one object share a name and can only be told apart by their order. A named
 * function expression and an enum member are here for the same reason: both
 * carry a name in places nothing else does, such as an array or a call. A
 * switch case earns its place too: the arms of a discriminated-union switch
 * often read alike while each narrows the value to a different type, so the
 * label is the only thing telling one arm's expression from another's. A
 * defaulted parameter is here because its default is code of its own, and two
 * parameters of one function can default to the same words. An assignment and
 * a JSX prop are here because both hand a callback somewhere without ever
 * declaring it — `handlers.text = (x) => …`, `<Widget text={(x) => …} />` —
 * and the target or the prop is the only name that callback has. */
const NAMING_TYPES = new Set([
  "AssignmentExpression",
  "AssignmentPattern",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "JSXAttribute",
  "MethodDefinition",
  "Property",
  "PropertyDefinition",
  "SwitchCase",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSInterfaceDeclaration",
  "TSModuleDeclaration",
  "TSTypeAliasDeclaration",
  "VariableDeclarator",
]);

type Node = Record<string, unknown>;

const isSpan = (value: unknown): value is Span =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Span).start === "number" &&
  typeof (value as Span).end === "number";

/**
 * Where the fingerprint stops climbing: the statement a mutant sits in. Going
 * past it would fold the mutant's neighbours into the fingerprint, so editing
 * an unrelated line in the same block would move an anchor that should have
 * stayed put. `Program` is a boundary too, so the search always finds one.
 */
const isBoundary = (node: Node): boolean =>
  typeof node.type === "string" &&
  (node.type === "Program" || /(?:Statement|Declaration)$/.test(node.type));

interface Descent {
  /** The span whose text is fingerprinted. */
  context: Span;
  names: string[];
}

/**
 * Walk down to a mutant's span, collecting the names enclosing it and the node
 * whose text is fingerprinted. Follows only the child holding the span, so the
 * cost is the tree's depth, not its size.
 *
 * The fingerprint covers the smallest node that *strictly* contains the mutant
 * without leaving its statement. A swapped operator sits in the gap inside its
 * own expression, so that expression is chosen — `a ?? 0`, not the array it
 * shares with its neighbours. A replaced literal *is* a node, so the node one
 * step out is chosen: the expression giving that literal its meaning. A removed
 * statement already fills its statement, so it is fingerprinted as itself —
 * never as the block it shares with the statements around it.
 */
const descendTo = (program: object, content: string, mutant: Span): Descent => {
  const width = mutant.end - mutant.start;
  const names: string[] = [];
  const path: Node[] = [];
  let node: object = program;
  for (;;) {
    const record = node as Node;
    const kind = record.type;
    if (typeof kind === "string" && NAMING_TYPES.has(kind)) {
      names.push(...namesOf(record as NamedNode, kind, content));
    }
    path.push(record);
    const next = Object.values(record)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find(
        (value) =>
          isSpan(value) &&
          value.start <= mutant.start &&
          mutant.start < value.end,
      );
    if (!next) break;
    node = next as object;
  }
  // Descending follows the mutant's first character, so the deepest nodes can
  // end before the mutant does. Only nodes holding all of it can name it.
  const holding = path.filter(
    (found): found is Node & Span =>
      isSpan(found) && found.start <= mutant.start && mutant.end <= found.end,
  );
  const withinStatement = holding.slice(holding.findLastIndex(isBoundary));
  const wider = withinStatement.findLast(
    (found) => found.end - found.start > width,
  );
  return { context: wider ?? withinStatement.at(-1)!, names };
};

interface AnchoredMutant {
  /** `name~fingerprint`, plus `@n` when two mutants are indistinguishable. */
  anchor: string;
}

interface HasLocation {
  end: number;
  newOperator: string;
  operator: string;
  start: number;
}

/**
 * Give every mutant its anchor.
 *
 * Two mutants collide only when they share an enclosing name, a `from → to`,
 * and character-identical expression text. Nothing in the code tells those
 * apart, so they fall back to source order as `@1`, `@2` — the one part of an
 * anchor a reordering can move, and the reason names are collected as finely
 * as they are. Anything short of that leaves every anchor alone.
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
    const { context, names } = descendTo(program, content, mutant);
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
