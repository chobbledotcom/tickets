/**
 * Mutation generation.
 *
 * Parses a source file with oxc-parser and walks the AST for binary, logical,
 * and assignment expressions, emitting one mutant per (operator → replacement)
 * pair from the tables in `operators.ts`. The walk strategy — locate the span
 * between `left.end` and `right.start` and swap the operator that lives there —
 * is derived from Mutasaurus (MIT); see LICENSE.mutasaurus.md.
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

/** A single mutation: replace the operator in [start, end) with newOperator. */
export interface Mutant {
  column: number;
  end: number;
  line: number;
  newOperator: string;
  operator: string;
  start: number;
}

/** The subset of an oxc AST node we care about. */
interface AstNode {
  left?: { end: number };
  operator?: string;
  right?: { start: number };
  type?: string;
}

const lineColumnAt = (
  content: string,
  index: number,
): { column: number; line: number } => {
  const lines = content.slice(0, index).split("\n");
  return { column: lines.at(-1)!.length + 1, line: lines.length };
};

/**
 * The mutable node types, each mapped to its [plain, exhaustive] operator
 * tables. A node whose `type` isn't a key here yields no mutants, so adding a
 * new mutable construct is a one-line table entry rather than another branch.
 */
const MUTABLE_NODES: Record<string, readonly [OperatorTable, OperatorTable]> = {
  AssignmentExpression: [assignmentOperators, assignmentOperatorsExhaustive],
  BinaryExpression: [binaryOperators, binaryOperatorsExhaustive],
  LogicalExpression: [logicalOperators, logicalOperatorsExhaustive],
};

/** Depth-first stream of every typed node in the tree. */
function* walk(node: unknown): Generator<AstNode> {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") yield record as AstNode;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child);
    } else if (value && typeof value === "object") {
      yield* walk(value);
    }
  }
}

/** Every mutant a single node yields — empty unless it's a mutable operator. */
const mutantsForNode =
  (content: string, exhaustive: boolean) =>
  (node: AstNode): Mutant[] => {
    const tables = node.type ? MUTABLE_NODES[node.type] : undefined;
    const { left, operator, right } = node;
    if (!tables || !left || !right || !operator) return [];
    const { column, line } = lineColumnAt(content, left.end);
    return (tables[exhaustive ? 1 : 0][operator] ?? []).map((newOperator) => ({
      column,
      end: right.start,
      line,
      newOperator,
      operator,
      start: left.end,
    }));
  };

/** Generate every mutant for a source file's contents. */
export const generateMutants = (
  content: string,
  filePath: string,
  exhaustive: boolean,
): Mutant[] => {
  const fileName = filePath.split("/").pop() ?? filePath;
  const { program } = parseSync(fileName, content);
  return flatMap(mutantsForNode(content, exhaustive))([...walk(program)]);
};

/** Apply a mutant to the original source, returning the mutated source. */
export const applyMutant = (content: string, mutant: Mutant): string =>
  `${content.slice(0, mutant.start)} ${mutant.newOperator} ${content.slice(
    mutant.end,
  )}`;
