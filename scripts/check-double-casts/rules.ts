/**
 * No `as unknown as`.
 *
 * The unchecked-assertion rule in AGENTS.md ("Offensive Programming — Never
 * Suppress Errors"): an `as` cast runs no code, it only tells TypeScript to
 * stop checking, so the failure surfaces wherever the impossible value is
 * first touched. A cast through `unknown` is the loudest form: any two types
 * bridge through `unknown`, so `as unknown as` asserts a shape nothing has
 * checked and erases the compiler's evidence first. Parse and validate at
 * the boundary, or narrow. This module is the ratchet between the rule and
 * the casts the code already carries: a file may hold only the count its
 * baseline entry records, a file with no entry may hold none, and the
 * baseline only falls — removing casts lets `--update` lower the entries,
 * and adding any cast fails the check.
 */

/* jscpd:ignore-start -- imports */
import { byLine } from "#scripts/check-report.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";
import { walkNodes } from "#scripts/walk-nodes.ts";
/* jscpd:ignore-end */

/** The count of double casts each accepted file carried when recorded. */
export type DoubleCasts = Record<string, number>;

/** The baseline file, named where a finding tells a reader what to edit. */
export const BASELINE = "scripts/check-double-casts/baseline.json";

/** Whether one `as` expression casts through `unknown` onto another cast:
 * `x as unknown as Shape` is an outer cast whose inner cast names unknown. */
const isUnknownDoubleCast = (node: Record<string, unknown>): boolean => {
  if (node.type !== "TSAsExpression") return false;
  const inner = node.expression as Record<string, unknown> | undefined;
  if (inner?.type !== "TSAsExpression") return false;
  return (
    (inner.typeAnnotation as Record<string, unknown> | undefined)?.type ===
    "TSUnknownKeyword"
  );
};

/** Every `as unknown as` cast in one file's content, in source order. */
const collectCasts = (file: string, content: string): number[] => {
  const starts: number[] = [];
  walkNodes(parseProgram(file, content), (node) => {
    if (isUnknownDoubleCast(node)) starts.push(node.start as number);
  });
  return starts.sort((left, right) => left - right);
};

/** How many `as unknown as` casts one file's content holds. */
export const countDoubleCasts = (file: string, content: string): number =>
  collectCasts(file, content).length;

/**
 * The findings one file's content holds, given the baseline's allowances:
 * every cast above the recorded count is a finding at its line, a file that
 * shrank below its count fails until its entry is lowered, and an entry for
 * a file that casts no more reports itself.
 */
export const findIssues = (
  file: string,
  content: string,
  accepted: DoubleCasts,
): PerFileFinding[] => {
  const recorded = accepted[file] ?? 0;
  const casts = collectCasts(file, content);
  if (casts.length > recorded) {
    return casts
      .map((start) => ({
        fix: "narrow or parse the value instead of casting through unknown",
        line: lineColumnAt(content, start).line,
        problem:
          "`as unknown as` casts through unknown, so nothing checks the shape",
        rule: "double-cast",
      }))
      .sort(byLine);
  }
  if (casts.length > 0 && casts.length < recorded) {
    return [
      {
        fix: `lower the entry in ${BASELINE}`,
        line: 1,
        problem:
          `holds ${casts.length} double casts, down from the recorded ` +
          recorded,
        rule: "improved",
      },
    ];
  }
  if (casts.length === 0 && file in accepted) {
    return [
      {
        fix: `delete the entry in ${BASELINE}`,
        line: 1,
        problem: "holds no double casts now",
        rule: "stale-entry",
      },
    ];
  }
  return [];
};
