/**
 * No empty catch.
 *
 * The offensive-programming rule in AGENTS.md: a `catch` that swallows the
 * error with no statement and no comment hides a failure; catch only when
 * there is a real recovery path. A catch whose only content is a comment is
 * the documented exception — the comment states the fallback on purpose, so
 * it stands. A promise callback counts as the same clause: a
 * `.catch(() => {})` that holds no statement and no comment is an empty
 * catch too.
 */

/* jscpd:ignore-start -- imports */
import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";
/* jscpd:ignore-end */

/** An empty catch the source says nothing about. */
export interface EmptyCatchIssue extends PerFileFinding {
  /** What the catch caught, as written: `catch`, `.catch`, or `catch (e)`. */
  caught: string;
}

/** Visit every node in one parsed program, depth-first. */
const walkNodes = (
  node: unknown,
  visit: (node: Record<string, unknown>) => void,
): void => {
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visit(record);
  for (const value of Object.values(record)) walkNodes(value, visit);
};

/** A node that sits between two offsets in the source it came from. */
interface Spanned {
  end: number;
  start: number;
}

/** An arrow body that is a block: `{ ... }`, spanning the source. */
interface BlockBody extends Spanned {
  body: unknown[];
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

/** Reads one source node and reports the empty catches it holds. */
type NodeCatches = (
  source: string,
  node: Record<string, unknown>,
) => EmptyCatchIssue[];

/** The empty `.catch(() => {})` callbacks in one call-expression node. */
const promiseCatches: NodeCatches = (source, node) => {
  const call = node as unknown as {
    arguments: Spanned[];
    callee: Record<string, unknown>;
  };
  const callee = call.callee;
  if (callee.type !== "MemberExpression") return [];
  const property = callee.property as Record<string, unknown>;
  if (property.name !== "catch") return [];
  const callback = call.arguments[0];
  if (callback === undefined) return [];
  const arrow = callback as unknown as Record<string, unknown>;
  if (arrow.type !== "ArrowFunctionExpression") return [];
  const body = arrow.body as Record<string, unknown> & Spanned;
  if (body.type !== "BlockStatement") return [];
  const block = body as unknown as BlockBody;
  if (block.body.length > 0) return [];
  if (blockExplainsItself(source, block)) return [];
  return [issueAt(source, callback.start, ".catch")];
};

/** The empty `catch {}` blocks in one catch-clause node. */
const clauseCatches: NodeCatches = (source, node) => {
  const clause = node as unknown as {
    body: BlockBody;
    param: Spanned | null;
    start: number;
  };
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

/** What one node holds, indexed by the node type the rules read. */
const catchesInNode: Record<string, NodeCatches> = {
  CallExpression: promiseCatches,
  CatchClause: clauseCatches,
};

/** Every empty catch whose body holds no statement and no comment. */
export const findIssues = (file: string, source: string): EmptyCatchIssue[] => {
  const program = parseProgram(file, source);
  const issues: EmptyCatchIssue[] = [];
  walkNodes(program, (node) => {
    const catches = catchesInNode[node.type as string];
    if (catches !== undefined) issues.push(...catches(source, node));
  });
  return issues.sort(byLine);
};
