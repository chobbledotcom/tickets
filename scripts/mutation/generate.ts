/**
 * Mutation generation.
 *
 * Parses a source file with oxc-parser and walks the AST, emitting mutants for:
 *   - binary / logical / assignment OPERATORS — swapped via the operators.ts tables
 *   - UNARY operators                         — `!x → x` (drop a guard), `-x ↔ +x`
 *   - UPDATE operators                        — `i++ ↔ i--`
 *   - boolean LITERALS                        — `true ↔ false`
 *   - string / numeric LITERALS               — `"x" → ""`, `5 → 0`
 *   - RETURN / THROW / loop-control flow      — dropped or neutralized
 *   - CONDITIONAL expressions                 — swapped/forced ternary arms
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
import { flatMap, unique } from "#fp";
import { lineColumnAt } from "#scripts/line-column.ts";
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
  alternate?: { end: number; start: number };
  argument?: { end: number; start: number };
  consequent?: { end: number; start: number };
  end?: number;
  expression?: { type?: string };
  left?: { end: number };
  operator?: string;
  prefix?: boolean;
  right?: { start: number };
  start?: number;
  test?: { end: number; start: number };
  type?: string;
  value?: unknown;
}

/**
 * A mutant generator for one node shape. `exhaustive` toggles the larger,
 * slower mutant set on; the two-argument generators simply ignore it.
 */
type MutantFn = (
  node: AstNode,
  content: string,
  exhaustive: boolean,
) => Mutant[];

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
  const base = { column, end, line, newOperator, operator, start };
  return replacement === undefined ? base : { ...base, replacement };
};

/** Whitespace-collapsed source of [start, end), truncated to ~40 chars. */
const clippedText = (content: string, start: number, end: number): string => {
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

// --- Binary / logical / assignment operators -----------------------------

const MUTABLE_NODES: Record<string, readonly [OperatorTable, OperatorTable]> = {
  AssignmentExpression: [assignmentOperators, assignmentOperatorsExhaustive],
  BinaryExpression: [binaryOperators, binaryOperatorsExhaustive],
  LogicalExpression: [logicalOperators, logicalOperatorsExhaustive],
};

const operatorMutants: MutantFn = (node, content, exhaustive) => {
  const { left, operator, right, type } = node as AstNode & {
    left: { end: number };
    operator: string;
    right: { start: number };
    type: keyof typeof MUTABLE_NODES;
  };
  const tables = MUTABLE_NODES[type]!;
  return tables[exhaustive ? 1 : 0][operator]!.map((newOperator) =>
    spanMutant(content, left.end, right.start, operator, newOperator),
  );
};

// --- Unary / update operators: `!x → x`, `-x ↔ +x`, `i++ ↔ i--` ----------

const UNARY_MUTATIONS: Record<
  string,
  ReadonlyArray<{ newOperator: string; replacement: string }>
> = {
  "-": [{ newOperator: "+", replacement: "+" }],
  "!": [{ newOperator: "∅", replacement: "" }],
  "+": [{ newOperator: "-", replacement: "-" }],
};

/** Mutants that replace the operator token sitting beside a node's argument —
 * before it for a prefix operator (`!x`, `++i`), after it for a postfix one
 * (`i++`). Shared by the unary and update mutators, which only differ in
 * which replacements they swap in. */
const argumentOperatorMutants = (
  node: AstNode,
  content: string,
  swaps: ReadonlyArray<{ newOperator: string; replacement: string }>,
): Mutant[] => {
  const { argument, end, operator, prefix, start } = node as AstNode & {
    argument: { end: number; start: number };
    end: number;
    operator: string;
    prefix: boolean;
    start: number;
  };
  // Prefix occupies [node.start, argument.start); postfix [argument.end, node.end).
  const [opStart, opEnd] = prefix
    ? [start, argument.start]
    : [argument.end, end];
  return swaps.map((m) =>
    spanMutant(content, opStart, opEnd, operator, m.newOperator, m.replacement),
  );
};

const unaryMutants = (node: AstNode, content: string): Mutant[] =>
  argumentOperatorMutants(
    node,
    content,
    // No entry means "no sensible mutation for this operator" — the documented
    // default for the unary operators we don't flip (typeof/void/delete/~), not
    // a swallowed missing value.
    UNARY_MUTATIONS[(node as AstNode & { operator: string }).operator] ?? [],
  );

const updateMutants = (node: AstNode, content: string): Mutant[] => {
  const flipped =
    (node as AstNode & { operator: "++" | "--" }).operator === "++"
      ? "--"
      : "++";
  return argumentOperatorMutants(node, content, [
    { newOperator: flipped, replacement: flipped },
  ]);
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

// --- Runtime literals: strings and numbers -------------------------------

const literalReplacementMutants = (
  node: AstNode,
  content: string,
  replacements: string[],
): Mutant[] => {
  const { end, start, value } = node as AstNode & {
    end: number;
    start: number;
  };
  const current = content.slice(start, end);
  return unique(replacements)
    .filter((replacement) => replacement !== current)
    .map((replacement) =>
      spanMutant(content, start, end, String(value), replacement, replacement),
    );
};

/** The literal's `value` when it is `type`, else undefined (skip the node). */
const literalValueOfType = <T>(
  node: AstNode,
  type: "number" | "string",
): T | undefined =>
  typeof node.value === type ? (node.value as T) : undefined;

const stringLiteralMutants: MutantFn = (node, content, exhaustive) => {
  const value = literalValueOfType<string>(node, "string");
  if (value === undefined) return [];
  const replacements =
    value === ""
      ? ['"mutated"']
      : ['""', ...(exhaustive ? [JSON.stringify(`${value} mutated`)] : [])];
  return literalReplacementMutants(node, content, replacements);
};

const numberText = (value: number): string => String(value);

const numberLiteralMutants: MutantFn = (node, content, exhaustive) => {
  const value = literalValueOfType<number>(node, "number");
  if (value === undefined) return [];
  const defaultValue = value === 0 ? 1 : 0;
  const values = [
    defaultValue,
    ...(exhaustive ? [value + 1, value - 1, -value] : []),
  ];
  const replacements = values.map(numberText);
  return literalReplacementMutants(node, content, replacements);
};

const literalMutants: MutantFn = (node, content, exhaustive) => [
  ...booleanMutants(node, content),
  ...numberLiteralMutants(node, content, exhaustive),
  ...stringLiteralMutants(node, content, exhaustive),
];

// --- Statement removals ----------------------------------------------------

/** Replace the whole statement with an empty one — valid even as a braceless
 * if/for/while body. Used directly for throw/break/continue, and via
 * {@link statementRemovalMutants} for side-effect expression statements. */
const statementRemoval = (node: AstNode, content: string): Mutant[] => {
  const { end, start } = node as AstNode & { end: number; start: number };
  return [
    spanMutant(
      content,
      start,
      end,
      clippedText(content, start, end),
      "(removed)",
      ";",
    ),
  ];
};

// Side-effect statement removal: `await persist(x); → ;`

const REMOVABLE_EXPRESSIONS = new Set(["AwaitExpression", "CallExpression"]);

const statementRemovalMutants = (node: AstNode, content: string): Mutant[] => {
  const { expression } = node as AstNode & { expression: { type: string } };
  return REMOVABLE_EXPRESSIONS.has(expression.type)
    ? statementRemoval(node, content)
    : [];
};

// --- Control-flow removals ------------------------------------------------

const returnMutants = (node: AstNode, content: string): Mutant[] => {
  const { argument } = node;
  if (!argument) return [];
  return [
    spanMutant(
      content,
      argument.start,
      argument.end,
      `return ${clippedText(content, argument.start, argument.end)}`,
      "return undefined",
      "undefined",
    ),
  ];
};

const conditionalMutants: MutantFn = (node, content, exhaustive) => {
  const { alternate, consequent, end, start } = node as AstNode & {
    alternate: { end: number; start: number };
    consequent: { end: number; start: number };
    end: number;
    start: number;
  };
  const consequentText = content.slice(consequent.start, consequent.end);
  const alternateText = content.slice(alternate.start, alternate.end);
  return [
    spanMutant(
      content,
      consequent.start,
      alternate.end,
      "?:",
      "arms swapped",
      `${alternateText} : ${consequentText}`,
    ),
    ...(exhaustive
      ? [
          spanMutant(
            content,
            start,
            end,
            "?:",
            "consequent only",
            consequentText,
          ),
          spanMutant(
            content,
            start,
            end,
            "?:",
            "alternate only",
            alternateText,
          ),
        ]
      : []),
  ];
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
        return literalMutants(node, content, exhaustive);
      case "ExpressionStatement":
        return statementRemovalMutants(node, content);
      case "ReturnStatement":
        return returnMutants(node, content);
      case "ThrowStatement":
      case "BreakStatement":
      case "ContinueStatement":
        return statementRemoval(node, content);
      case "ConditionalExpression":
        return conditionalMutants(node, content, exhaustive);
      default:
        return [];
    }
  };

/**
 * Fields whose value is not runtime code. Crossing one enters a non-runtime
 * context, and nothing below it is worth mutating. Keying on the field (not the
 * node's type) means runtime code carried by TS-prefixed nodes is still mutated
 * — e.g. `enum E { A = 1 + 2 }`, `constructor(private x = build())`, and the
 * operand of `x as T`.
 */
const NON_RUNTIME_FIELDS = new Set([
  "returnType",
  "source",
  "superTypeArguments",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
]);

/**
 * Depth-first stream of every typed node, tagged with whether it sits inside a
 * non-runtime context. Types are erased at runtime, module specifiers are load
 * wiring rather than application behavior, and `declare` statements are
 * ambient (erased) declarations, so those nodes are skipped. Array elisions
 * (`const [, year] = parts`) appear as `null` children, hence the guard.
 */
function* walk(
  node: unknown,
  inNonRuntime = false,
): Generator<{ inNonRuntime: boolean; node: AstNode }> {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const nonRuntime = inNonRuntime || record.declare === true;
  if (typeof record.type === "string")
    yield { inNonRuntime: nonRuntime, node: record as AstNode };
  for (const [key, value] of Object.entries(record)) {
    const childInNonRuntime = nonRuntime || NON_RUNTIME_FIELDS.has(key);
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child, childInNonRuntime);
    } else if (value && typeof value === "object") {
      yield* walk(value, childInNonRuntime);
    }
  }
}

/**
 * Generate every mutant for a source file's contents. Declaration files are
 * entirely ambient — erased at runtime, run with `--no-check` — so no test can
 * observe a mutation to one; they yield no mutants rather than false survivors.
 */
export const generateMutants = (
  content: string,
  filePath: string,
  exhaustive: boolean,
): Mutant[] => {
  if (filePath.endsWith(".d.ts")) return [];
  const fileName = filePath.split("/").pop() as string;
  const { program } = parseSync(fileName, content);
  const mutate = mutantsForNode(content, exhaustive);
  return flatMap((entry: { inNonRuntime: boolean; node: AstNode }) =>
    entry.inNonRuntime ? [] : mutate(entry.node),
  )([...walk(program)]);
};

/** Apply a mutant to the original source, returning the mutated source. */
export const applyMutant = (content: string, mutant: Mutant): string => {
  const replacement = mutant.replacement ?? mutant.newOperator;
  return `${content.slice(0, mutant.start)} ${replacement} ${content.slice(mutant.end)}`;
};
