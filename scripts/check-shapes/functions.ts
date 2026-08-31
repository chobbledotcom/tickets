/**
 * Every function in a parsed file that has a name to report it by, with the
 * span of its body. A function nobody named — a callback passed inline — is
 * left out, because a finding has to say which two things to merge.
 */

import { mapNotNullish } from "#fp";
import type { Masked, Span } from "./shape.ts";

/** One named function's body, located in the file it came from. */
export interface NamedFunction extends Span {
  line: number;
  name: string;
}

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

interface AstNode {
  type: string;
  [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** The text a node is named or keyed by. A plain name carries it in `name`; a
 * literal key — the route strings in `src/features/static.ts` — carries it in
 * `value`, so `{ "GET /health": … }` names the handler it holds. Anything that
 * is not a node has no name, which is how the walk below ends. */
const keyText = (named: unknown): string | null => {
  if (!isAstNode(named)) return null;
  if (typeof named.name === "string") return named.name;
  const { value } = named;
  const literal = typeof value === "string" || typeof value === "number";
  return literal ? String(value) : null;
};

/** The name a node declares or is keyed by. A declaration carries its own
 * `id`; a property, a class member and an object method carry a `key`, so
 * `{ save: () => … }`, `{ save() {} }` and `class A { save() {} }` all name
 * the function they hold. A conditional hands its name to both arms, because
 * the function a test selects is still that one function. */
const declaredName = (node: AstNode): string | null =>
  keyText(node.id) ?? keyText(node.key) ?? assignedTo(node);

/** Nodes that hand a name on to the function inside them. A declaration or a
 * property names what it holds. A call hands on the name it was given, because
 * `const handleBook = withActiveListing(async (…) => …)` names that handler
 * and nothing else does — the call itself has no name of its own. */
const HANDS_A_NAME_ON = new Set([
  "AssignmentExpression",
  "CallExpression",
  "ConditionalExpression",
  "MethodDefinition",
  "ObjectProperty",
  "Property",
  "PropertyDefinition",
  "VariableDeclarator",
]);

/** The name a target is installed under: its own, or the property it writes.
 *  `handlers = …` names by the target, `script.onload = …` by the property. A
 *  target with no name anywhere — `handlers[pick()] = …` — has none. */
const nameOfTarget = (target: unknown): string | null =>
  keyText(target) ?? (isAstNode(target) ? nameOfTarget(target.property) : null);

/** The name an assignment installs a function under. */
const assignedTo = (node: AstNode): string | null =>
  node.type === "AssignmentExpression" ? nameOfTarget(node.left) : null;

/** Counts the newlines before an offset, so a finding can name a line. */
const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") line++;
  }
  return line;
};

/**
 * The full name of a function: the names it sits inside, then its own. A leaf
 * name alone is not enough, because one file can hold several `save` methods.
 */
const qualify = (
  name: string | null,
  within: readonly string[],
): string | null => {
  if (name === null) return null;
  const path = within.at(-1) === name ? within : [...within, name];
  return path.join(".");
};

/** This node's body, when it is a function with a name to report it by. Every
 * type in {@link FUNCTION_TYPES} carries a body: a function written without one
 * parses as `TSDeclareFunction`, which is not in the set. */
const functionBody = (
  node: AstNode,
  name: string | null,
  source: string,
): NamedFunction | null => {
  if (!FUNCTION_TYPES.has(node.type) || name === null) return null;
  const body = node.body as Span;
  return {
    end: body.end,
    line: lineAt(source, body.start),
    name,
    start: body.start,
  };
};

/** One node, the name in scope for it, and the names it sits inside. */
interface Found {
  name: string | null;
  node: AstNode;
  within: readonly string[];
}

/**
 * Every node in the tree, each carrying the variable name in scope for it and
 * the names it sits inside. `const format = (value) => …` puts `format` in
 * scope for the arrow beside it, and so do a property, a class member and an
 * object method. A call hands that name on to the function it wraps, so the
 * body of `const handleBook = withActiveListing(async (…) => …)` is read. A
 * function does not, so the arrow inside a curried factory is not named again
 * and the factory reports once.
 *
 * The names it sits inside build up separately, because two methods called
 * `save` in one file are two functions, and a finding has to say which.
 */
function* walk(
  node: unknown,
  assignedName: string | null,
  within: readonly string[],
): Generator<Found> {
  if (Array.isArray(node)) {
    // A list carries the name on rather than ending it, because a call holds
    // the function it wraps in its argument list.
    for (const child of node) yield* walk(child, assignedName, within);
    return;
  }
  if (!isAstNode(node)) return;
  const own = declaredName(node);
  yield { name: own ?? assignedName, node, within };
  const passDown = HANDS_A_NAME_ON.has(node.type)
    ? (own ?? assignedName)
    : null;
  const inside = own === null ? within : [...within, own];
  for (const [key, value] of Object.entries(node)) {
    if (key !== "type") yield* walk(value, passDown, inside);
  }
}

/** Every function in the file that has a name to report it by. */
export const namedFunctions = (
  program: unknown,
  source: string,
): NamedFunction[] =>
  mapNotNullish(({ name, node, within }: Found) =>
    functionBody(node, qualify(name, within), source),
  )([...walk(program, null, [])]);

/** What one node stands for once it is masked, or nothing when it stays as
 *  written. A name becomes `_`, which reads as any other name; the words a
 *  component renders become one string, and whitespace between elements goes
 *  altogether, because JSX drops it and `deno fmt` moves it. */
const maskFor = (node: AstNode, source: string): string | null => {
  // A JSX name — an element or an attribute — is a name somebody chose, not
  // the keyword it spells: `class={…}` and `type={…}` must read as names.
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return "_";
  // A closing tag reads as one without repeating the element's name, which the
  // opening tag already carried — a fragment's `</>` too. Dropping the `/`
  // also keeps the tokeniser from reading `</b>` as a pattern opening after
  // `<`.
  if (node.type === "JSXClosingElement" || node.type === "JSXClosingFragment") {
    return "<>";
  }
  if (node.type !== "JSXText") return null;
  return /\S/.test(source.slice(node.start as number, node.end as number))
    ? '""'
    : "";
};

/**
 * Every run of the file that must read as one symbol whatever it says: each
 * name somebody chose, and each word a component renders. The parser decides,
 * so a keyword used as a name — `row.type`, `{ type }`, `(type) => …` — is a
 * name, and only real syntax survives.
 */
export const maskedRuns = (program: unknown, source: string): Masked[] =>
  mapNotNullish(({ node }: { node: AstNode }) => {
    const as = maskFor(node, source);
    return as === null
      ? null
      : { as, end: node.end as number, start: node.start as number };
  })([...walk(program, null, [])]);
