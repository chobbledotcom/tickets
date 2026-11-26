/**
 * No empty catch.
 *
 * The offensive-programming rule in AGENTS.md: a `catch` that swallows the
 * error with no statement and no comment hides a failure; catch only when
 * there is a real recovery path. A catch whose only content is a comment is
 * the documented exception — the comment states the fallback on purpose, so
 * it stands. A promise callback counts as the same clause: a `.catch(() => {})`
 * or `.catch(function () {})` that holds no statement and no comment is an
 * empty catch too, and so is an empty rejection handler passed to
 * `.then(onSuccess, () => {})`. A callback passed by name cannot be read
 * here, so the gate leaves it to its own definition.
 */

import type {
  CallExpression,
  CatchClause,
  Expression,
} from "npm:oxc-parser@0.132.0";
import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";
import { type ProgramNode, walkNodes } from "#scripts/walk-nodes.ts";

/** An empty catch the source says nothing about. */
export interface EmptyCatchIssue extends PerFileFinding {
  /** What the catch caught, as written: `catch`, `.catch`, or `catch (e)`. */
  caught: string;
}

/** A node that sits between two offsets in the source it came from. */
interface Spanned {
  end: number;
  start: number;
}

/** Whether the text between a catch's braces says anything at all. */
const blockExplainsItself = (source: string, body: Spanned): boolean =>
  source
    .slice(body.start, body.end)
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim().length > 0;

/** Report one empty catch, found at `start` in the source. */
const issueAt = (
  source: string,
  start: number,
  caught: string,
): EmptyCatchIssue => ({
  caught,
  fix: "recover, re-raise, or comment the fallback you chose",
  line: lineColumnAt(source, start).line,
  problem: `"${caught} {}" holds no statement and no comment`,
  rule: "empty-catch",
});

/** The property a member expression names, whether spelled as an identifier
 * (`p.catch`) or a computed string literal (`p["catch"]`). */
const memberName = (callee: Expression): string | null => {
  if (callee.type !== "MemberExpression") return null;
  const key = callee.property;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
};

/** The empty rejection callbacks in one call expression: the first argument
 * of `.catch(…)`, or the second of `.then(…, …)` — both swallow a rejection
 * the same way. */
const promiseCatches = (
  source: string,
  call: CallExpression,
): EmptyCatchIssue[] => {
  const member = memberName(call.callee);
  const callback =
    member === "catch"
      ? call.arguments[0]
      : member === "then"
        ? call.arguments[1]
        : undefined;
  if (callback === undefined) return [];
  const isCallbackBody =
    callback.type === "ArrowFunctionExpression" ||
    callback.type === "FunctionExpression";
  if (!isCallbackBody) return [];
  const body = callback.body;
  if (body === null || body.type !== "BlockStatement") return [];
  if (body.body.length > 0) return [];
  if (blockExplainsItself(source, body)) return [];
  return [
    issueAt(
      source,
      callback.start,
      member === "catch" ? ".catch" : ".then rejection handler",
    ),
  ];
};

/** The empty `catch {}` blocks in one catch-clause node. */
const clauseCatches = (
  source: string,
  clause: CatchClause,
): EmptyCatchIssue[] => {
  if (clause.body.body.length > 0) return [];
  if (blockExplainsItself(source, clause.body)) return [];
  return [
    issueAt(
      source,
      clause.start,
      clause.param === null
        ? "catch"
        : `catch (${source.slice(clause.param.start, clause.param.end)})`,
    ),
  ];
};

const isCall = (node: ProgramNode): node is ProgramNode & CallExpression =>
  node.type === "CallExpression";

const isClause = (node: ProgramNode): node is ProgramNode & CatchClause =>
  node.type === "CatchClause";

/** The empty catches one node holds, by the node type the rules read. */
const catchesInNode = (
  source: string,
  node: ProgramNode,
): EmptyCatchIssue[] => {
  if (isCall(node)) return promiseCatches(source, node);
  if (isClause(node)) return clauseCatches(source, node);
  return [];
};

/** Every empty catch whose body holds no statement and no comment. */
export const findIssues = (file: string, source: string): EmptyCatchIssue[] => {
  const program = parseProgram(file, source);
  const issues: EmptyCatchIssue[] = [];
  walkNodes(program, (node) => {
    issues.push(...catchesInNode(source, node));
  });
  return issues.sort(byLine);
};
