/**
 * Mutation generation.
 *
 * Parses a source file with oxc-parser and walks the AST, emitting mutants for:
 *   - binary / logical / assignment OPERATORS — swapped via the operators.ts tables
 *   - UNARY operators                         — `!x → x` (drop a guard), `-x ↔ +x`
 *   - UPDATE operators                        — `i++ ↔ i--`
 *   - boolean LITERALS                        — `true ↔ false`
 *   - side-effect STATEMENTS                  — `await persist(x); → ;`
 *
 * Each mutant is a source span [start, end) replaced by `replacement` (which
 * defaults to the displayed `newOperator`). The operator-swap strategy — locate
 * the span between `left.end` and `right.start` — is derived from Mutasaurus
 * (MIT); see LICENSE.mutasaurus.md.
 *
 * oxc-parser reports UTF-16 offsets, so the `start`/`end` indices splice the
 * JavaScript source string directly, even when it contains non-ASCII text.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";
import { flatMap } from "#fp";
import {
  assignmentOperators,
  assignmentOperatorsExhaustive,
  binaryOperators,
  binaryOperatorsExhaustive,
  logicalOperators,
  logicalOperatorsExhaustive,
  type OperatorTable,
} from "./operators.ts";

/**
 * A single mutation: splice `replacement` (default: `newOperator`) into the
 * source span [start, end). `operator`/`newOperator` are the human-readable
 * before → after shown in the report.
 */
export interface Mutant {
  column: number;
  end: number;
  line: number;
  newOperator: string;
  operator: string;
  replacement?: string;
  start: number;
}

/** The subset of an oxc AST node we care about (covers every mutated shape). */
interface AstNode {
  argument?: { end: number; start: number };
  end?: number;
  expression?: { type?: string };
  left?: { end: number };
  operator?: string;
  prefix?: boolean;
  right?: { start: number };
  start?: number;
  type?: string;
  value?: unknown;
}

const lineColumnAt = (
  content: string,
  index: number,
): { column: number; line: number } => {
  const lines = content.slice(0, index).split("\n");
  return { column: lines.at(-1)!.length + 1, line: lines.length };
};

/** Build a mutant for the span [start, end), resolving its line/column. */
const spanMutant = (
  content: string,
  start: number,
  end: number,
  operator: string,
  newOperator: string,
  replacement?: string,
): Mutant => {
  const { column, line } = lineColumnAt(content, start);
  return { column, end, line, newOperator, operator, replacement, start };
};

// --- Binary / logical / assignment operators -----------------------------

const MUTABLE_NODES: Record<string, readonly [OperatorTable, OperatorTable]> = {
  AssignmentExpression: [assignmentOperators, assignmentOperatorsExhaustive],
  BinaryExpression: [binaryOperators, binaryOperatorsExhaustive],
  LogicalExpression: [logicalOperators, logicalOperatorsExhaustive],
};

const operatorMutants = (
  node: AstNode,
  content: string,
  exhaustive: boolean,
): Mutant[] => {
  const tables = node.type ? MUTABLE_NODES[node.type] : undefined;
  const { left, operator, right } = node;
  if (!tables || !left || !right || !operator) return [];
  return (tables[exhaustive ? 1 : 0][operator] ?? []).map((newOperator) =>
    spanMutant(content, left.end, right.start, operator, newOperator),
  );
};

// --- Unary operators: `!x → x` (drop a guard), `-x ↔ +x` -----------------

const UNARY_MUTATIONS: Record<
  string,
  ReadonlyArray<{ newOperator: string; replacement: string }>
> = {
  "-": [{ newOperator: "+", replacement: "+" }],
  "!": [{ newOperator: "∅", replacement: "" }],
  "+": [{ newOperator: "-", replacement: "-" }],
};

const unaryMutants = (node: AstNode, content: string): Mutant[] => {
  const { argument, operator, start } = node;
  if (!argument || operator === undefined || start === undefined) return [];
  // A prefix unary operator occupies [node.start, argument.start).
  return (UNARY_MUTATIONS[operator] ?? []).map((m) =>
    spanMutant(
      content,
      start,
      argument.start,
      operator,
      m.newOperator,
      m.replacement,
    ),
  );
};

// --- Update operators: `i++ ↔ i--` ---------------------------------------

const updateMutants = (node: AstNode, content: string): Mutant[] => {
  const { argument, end, operator, prefix, start } = node;
  if (
    !argument ||
    operator === undefined ||
    start === undefined ||
    end === undefined
  ) {
    return [];
  }
  const flipped = operator === "++" ? "--" : "++";
  // Prefix occupies [node.start, argument.start); postfix [argument.end, node.end).
  const [opStart, opEnd] = prefix
    ? [start, argument.start]
    : [argument.end, end];
  return [spanMutant(content, opStart, opEnd, operator, flipped, flipped)];
};

// --- Boolean literals: `true ↔ false` ------------------------------------

const booleanMutants = (node: AstNode, content: string): Mutant[] => {
  if (
    typeof node.value !== "boolean" ||
    node.start === undefined ||
    node.end === undefined
  ) {
    return [];
  }
  const to = String(!node.value);
  return [
    spanMutant(content, node.start, node.end, String(node.value), to, to),
  ];
};

// --- Side-effect statement removal: `await persist(x); → ;` ---------------

const REMOVABLE_EXPRESSIONS = new Set(["AwaitExpression", "CallExpression"]);

const statementRemovalMutants = (node: AstNode, content: string): Mutant[] => {
  const { end, expression, start } = node;
  if (
    !expression ||
    !REMOVABLE_EXPRESSIONS.has(expression.type ?? "") ||
    start === undefined ||
    end === undefined
  ) {
    return [];
  }
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  const label = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  // Replace with an empty statement — valid even as a braceless if/for/while body.
  return [spanMutant(content, start, end, label, "(removed)", ";")];
};

// --- Dispatch + entry point ----------------------------------------------

const mutantsForNode =
  (content: string, exhaustive: boolean) =>
  (node: AstNode): Mutant[] => {
    switch (node.type) {
      case "AssignmentExpression":
      case "BinaryExpression":
      case "LogicalExpression":
        return operatorMutants(node, content, exhaustive);
      case "UnaryExpression":
        return unaryMutants(node, content);
      case "UpdateExpression":
        return updateMutants(node, content);
      case "Literal":
        return booleanMutants(node, content);
      case "ExpressionStatement":
        return statementRemovalMutants(node, content);
      default:
        return [];
    }
  };

/**
 * Fields whose value is a TypeScript type rather than runtime code. Crossing one
 * enters type context, and nothing runtime lives below a type, so the flag
 * sticks. Keying on the field (not the node's type) means runtime code carried
 * by TS-prefixed nodes is still mutated — e.g. `enum E { A = 1 + 2 }`,
 * `constructor(private x = build())`, and the operand of `x as T`.
 */
const TYPE_FIELDS = new Set([
  "returnType",
  "superTypeArguments",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
]);

/**
 * Depth-first stream of every typed node, tagged with whether it sits inside a
 * TypeScript type. A type is erased at runtime, so mutating it (e.g. the `true`
 * in `{ ok: true }`) is always an equivalent no-op — those nodes are skipped.
 */
function* walk(
  node: unknown,
  inType = false,
): Generator<{ inType: boolean; node: AstNode }> {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string")
    yield { inType, node: record as AstNode };
  for (const [key, value] of Object.entries(record)) {
    const childInType = inType || TYPE_FIELDS.has(key);
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child, childInType);
    } else if (value && typeof value === "object") {
      yield* walk(value, childInType);
    }
  }
}

/** Generate every mutant for a source file's contents. */
export const generateMutants = (
  content: string,
  filePath: string,
  exhaustive: boolean,
): Mutant[] => {
  const fileName = filePath.split("/").pop() ?? filePath;
  const { program } = parseSync(fileName, content);
  const mutate = mutantsForNode(content, exhaustive);
  return flatMap((entry: { inType: boolean; node: AstNode }) =>
    entry.inType ? [] : mutate(entry.node),
  )([...walk(program)]);
};

/** Apply a mutant to the original source, returning the mutated source. */
export const applyMutant = (content: string, mutant: Mutant): string =>
  `${content.slice(0, mutant.start)} ${
    mutant.replacement ?? mutant.newOperator
  } ${content.slice(mutant.end)}`;
