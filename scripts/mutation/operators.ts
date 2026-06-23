/**
 * Mutation operator tables.
 *
 * Vendored from Mutasaurus (MIT, Christos Hrousis) — see LICENSE.mutasaurus.md
 * in this directory. These map each binary/assignment operator found in the
 * source to the operator(s) it should be mutated into.
 *
 * Non-exhaustive mode picks a single, deliberately "distant" replacement per
 * operator (fast, still catches most weak assertions). Exhaustive mode tries
 * every sensible replacement (slower, more thorough).
 */

export type OperatorTable = Record<string, string[]>;

/** Binary operator → replacement (one distant mutation each). */
export const binaryOperators: OperatorTable = {
  "-": ["/"],
  "!=": ["==="],
  "!==": ["=="],
  "*": ["-"],
  "**": ["+"],
  "/": ["+"],
  "&": [],
  "%": ["+"],
  "^": [],
  "+": ["*"],
  "<": [">="],
  "<<": [],
  "<=": [">"],
  "==": ["!=="],
  "===": ["!="],
  ">": ["<="],
  ">=": ["<"],
  ">>": [],
  ">>>": [],
  "|": [],
  in: [],
  instanceof: [],
};

/** Binary operator → every sensible replacement. */
export const binaryOperatorsExhaustive: OperatorTable = {
  "-": ["+", "*", "/"],
  "!=": ["==", "===", "!=="],
  "!==": ["==", "!=", "==="],
  "*": ["+", "-", "/"],
  "**": ["+", "-", "*"],
  "/": ["+", "-", "*"],
  "&": [],
  "%": ["+", "-", "*"],
  "^": [],
  "+": ["-", "*", "/"],
  "<": ["<=", ">", ">="],
  "<<": [],
  "<=": ["<", ">", ">="],
  "==": ["===", "!=", "!=="],
  "===": ["==", "!=", "!=="],
  ">": ["<", "<=", ">="],
  ">=": ["<", "<=", ">"],
  ">>": [],
  ">>>": [],
  "|": [],
  in: ["+"],
  instanceof: [],
};

/**
 * Logical operator → replacement (one distant mutation each).
 *
 * `&&`/`||`/`??` are `LogicalExpression` nodes (not `BinaryExpression`), so the
 * walk in `generate.ts` routes them here. `&&`↔`||` is always syntactically
 * valid; `??` cannot be mixed with `&&`/`||` without parentheses, so a `??`
 * mutation on a *chained* `a ?? b ?? c` produces a stillborn mutant that simply
 * fails to compile and is counted as killed — conservative (never a false
 * survivor), and standalone `a ?? b` (the common case) mutates cleanly.
 */
export const logicalOperators: OperatorTable = {
  "??": ["||"],
  "&&": ["||"],
  "||": ["&&"],
};

/** Logical operator → every sensible replacement. */
export const logicalOperatorsExhaustive: OperatorTable = {
  "??": ["&&", "||"],
  "&&": ["||", "??"],
  "||": ["&&", "??"],
};

/** Assignment operator → replacement (one distant mutation each). */
export const assignmentOperators: OperatorTable = {
  "-=": ["*="],
  "??=": ["="],
  "**=": ["-="],
  "*=": ["-="],
  "/=": ["+="],
  "&&=": ["="],
  "&=": ["="],
  "%=": ["="],
  "^=": ["="],
  "+=": ["/="],
  "<<=": ["="],
  "=": ["+="],
  ">>=": ["="],
  ">>>=": ["="],
  "|=": ["="],
  "||=": ["="],
};

/** Assignment operator → every sensible replacement. */
export const assignmentOperatorsExhaustive: OperatorTable = {
  "-=": ["=", "+=", "*=", "/="],
  "??=": ["=", "-=", "*=", "/="],
  "**=": ["=", "-=", "*=", "/="],
  "*=": ["=", "-=", "+=", "/="],
  "/=": ["=", "-=", "*=", "+="],
  "&&=": ["=", "-=", "*=", "/="],
  "&=": ["=", "-=", "*=", "/="],
  "%=": ["=", "-=", "*=", "/="],
  "^=": ["=", "-=", "*=", "/="],
  "+=": ["=", "-=", "*=", "/="],
  "<<=": ["=", "-=", "*=", "/="],
  "=": ["+="],
  ">>=": ["=", "-=", "*=", "/="],
  ">>>=": ["=", "-=", "*=", "/="],
  "|=": ["=", "-=", "*=", "/="],
  "||=": ["=", "-=", "*=", "/="],
};
