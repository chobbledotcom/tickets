/**
 * Every function in a parsed file that has a name to report it by, with the
 * span of its body. A function nobody named — a callback passed inline — is
 * left out, because a finding has to say which two things to merge.
 */

import { mapNotNullish } from "#fp";
import type { Span } from "./shape.ts";

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

/** The name a node declares or is keyed by. A declaration carries its own
 * `id`; a property, a class member and an object method carry a `key`, so
 * `{ save: () => … }`, `{ save() {} }` and `class A { save() {} }` all name
 * the function they hold. */
const declaredName = (node: AstNode): string | null => {
  const named = isAstNode(node.id) ? node.id : node.key;
  return isAstNode(named) && typeof named.name === "string" ? named.name : null;
};

/** Nodes that put their name in scope for the function they hold. */
const NAMING_TYPES = new Set([
  "MethodDefinition",
  "ObjectProperty",
  "Property",
  "PropertyDefinition",
  "VariableDeclarator",
]);

/** Counts the newlines before an offset, so a finding can name a line. */
const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") line++;
  }
  return line;
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

/**
 * Every node in the tree, each carrying the variable name in scope for it.
 * `const format = (value) => …` puts `format` in scope for the arrow beside
 * it, and so do a property, a class member and an object method. Nothing else
 * passes a name down, so the arrow inside a curried factory is not named again
 * and the factory reports once.
 */
function* walk(
  node: unknown,
  assignedName: string | null,
): Generator<{ name: string | null; node: AstNode }> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, null);
    return;
  }
  if (!isAstNode(node)) return;
  const name = declaredName(node) ?? assignedName;
  yield { name, node };
  const passDown = NAMING_TYPES.has(node.type) ? name : null;
  for (const [key, value] of Object.entries(node)) {
    if (key !== "type") yield* walk(value, passDown);
  }
}

/** Every function in the file that has a name to report it by. */
export const namedFunctions = (
  program: unknown,
  source: string,
): NamedFunction[] =>
  mapNotNullish(({ name, node }: { name: string | null; node: AstNode }) =>
    functionBody(node, name, source),
  )([...walk(program, null)]);

/**
 * Every run of literal text inside JSX, in the order it appears. `<b>Save</b>`
 * holds one, and without it the tokeniser reads `Save` as a name — so two
 * components that differ only in their wording would read as two shapes.
 */
export const jsxTextSpans = (program: unknown): Span[] =>
  mapNotNullish(({ node }: { node: AstNode }) =>
    node.type === "JSXText"
      ? { end: node.end as number, start: node.start as number }
      : null,
  )([...walk(program, null)]);
