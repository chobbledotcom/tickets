/**
 * No empty catch block.
 *
 * The offensive-programming rule in AGENTS.md: a `catch` that swallows the
 * error with no statement and no comment hides a failure; catch only when
 * there is a real recovery path. A catch whose only content is a comment is
 * the documented exception — the comment states the fallback on purpose, so
 * it stands. `.catch(() => {})` arrow callbacks are a different, deliberate
 * idiom elsewhere in this codebase and are not catch *blocks*.
 */

/* jscpd:ignore-start -- imports */
import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";
/* jscpd:ignore-end */

/** An empty catch block the source says nothing about. */
export interface EmptyCatchIssue extends PerFileFinding {
  /** What the catch caught, as written: `catch` or `catch (e)`. */
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

/** Whether the text between a catch's braces says anything at all. */
const blockExplainsItself = (source: string, body: Spanned): boolean =>
  source
    .slice(body.start, body.end)
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim().length > 0;

/** Every catch block whose body holds no statement and no comment. */
export const findIssues = (file: string, source: string): EmptyCatchIssue[] => {
  const issues: EmptyCatchIssue[] = [];
  const program = parseProgram(file, source);
  walkNodes(program, (node) => {
    if (node.type !== "CatchClause") return;
    const body = node.body as { body: unknown[] } & Spanned;
    if (body.body.length > 0) return;
    if (blockExplainsItself(source, body)) return;
    const param = node.param as Spanned | null;
    issues.push({
      caught:
        param === null
          ? "catch"
          : `catch (${source.slice(param.start, param.end)})`,
      fix: "recover, re-raise, or comment the fallback you chose",
      line: lineColumnAt(source, node.start as number).line,
      problem: `"catch {}" holds no statement and no comment`,
      rule: "empty-catch",
    });
  });
  return issues.sort(byLine);
};
