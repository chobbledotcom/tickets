/**
 * Mutation generation.
 *
 * Parses a source file with oxc-parser and walks the AST for binary and
 * assignment expressions, emitting one mutant per (operator → replacement)
 * pair from the tables in `operators.ts`. The walk strategy — locate the span
 * between `left.end` and `right.start` and swap the operator that lives there —
 * is derived from Mutasaurus (MIT); see LICENSE.mutasaurus.md.
 *
 * oxc-parser reports UTF-16 offsets, so the `start`/`end` indices splice the
 * JavaScript source string directly, even when it contains non-ASCII text.
 */

import { parseSync } from "npm:oxc-parser@0.132.0";
import {
  assignmentOperators,
  assignmentOperatorsExhaustive,
  binaryOperators,
  binaryOperatorsExhaustive,
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

const tableFor = (type: string, exhaustive: boolean): OperatorTable => {
  if (type === "BinaryExpression") {
    return exhaustive ? binaryOperatorsExhaustive : binaryOperators;
  }
  return exhaustive ? assignmentOperatorsExhaustive : assignmentOperators;
};

const walk = (node: unknown, visit: (node: AstNode) => void): void => {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record as AstNode);
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
};

/** Generate every mutant for a source file's contents. */
export const generateMutants = (
  content: string,
  filePath: string,
  exhaustive: boolean,
): Mutant[] => {
  const fileName = filePath.split("/").pop() ?? filePath;
  const { program } = parseSync(fileName, content);
  const mutants: Mutant[] = [];

  walk(program, (node) => {
    const isBinary = node.type === "BinaryExpression";
    if (!isBinary && node.type !== "AssignmentExpression") return;
    if (!node.left || !node.right || !node.operator) return;

    const start = node.left.end;
    const end = node.right.start;
    const { column, line } = lineColumnAt(content, start);
    for (const newOperator of tableFor(node.type!, exhaustive)[node.operator] ??
      []) {
      mutants.push({
        column,
        end,
        line,
        newOperator,
        operator: node.operator,
        start,
      });
    }
  });

  return mutants;
};

/** Apply a mutant to the original source, returning the mutated source. */
export const applyMutant = (content: string, mutant: Mutant): string =>
  `${content.slice(0, mutant.start)} ${mutant.newOperator} ${content.slice(
    mutant.end,
  )}`;
