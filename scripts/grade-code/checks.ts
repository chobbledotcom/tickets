/**
 * The check schema: the mechanical half runs the repository's own rule
 * functions against one file, so a grade agrees with `deno task precommit`,
 * and the judgement half asks the questions in questions.ts. Weights and
 * applicability all live in the two lists below.
 */

import { findIssues as findAliasExportIssues } from "#scripts/check-alias-exports/rules.ts";
import { findCommentIssues } from "#scripts/check-comments/rules.ts";
import { LIMITS } from "#scripts/check-comments/run.ts";
import { findIssues as findEmptyCatchIssues } from "#scripts/check-empty-catch/rules.ts";
import type { OverLimit } from "#scripts/check-file-lengths/rules.ts";
import { type Alias, findImportIssues } from "#scripts/check-imports/rules.ts";
import type { PerFileFinding } from "#scripts/check-runner.ts";
import type { CodeFacts } from "./extract.ts";
import {
  JEV_QUESTIONS,
  type JevQuestion,
  type ScoreQuestion,
} from "./questions.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

/** What one check concluded about the file. */
export interface Verdict {
  /** The share of the check's weight the file earned. */
  goodness: number;
  note: string;
  status: CheckStatus;
}

/** What the repo-wide scans know, loaded once per run. */
export interface GradeContext {
  aliases: Alias[];
  overLimit: OverLimit;
}

export type CheckEngine = "code" | "jev";

export interface CheckEntry {
  critical?: boolean;
  engine: CheckEngine;
  fn?: (facts: CodeFacts, ctx: GradeContext) => Verdict;
  id: string;
  label: string;
  question?: ScoreQuestion;
  requires?: (facts: CodeFacts) => boolean;
  score_pass?: number;
  score_warn?: number;
  weight: number;
}

export interface MechanicalCheckResult extends Verdict {
  critical: boolean;
  engine: "code";
  label: string;
  weight: number;
}

/** A verdict from how many times something happens, against the count that
 * worries and the count that fails. */
const scaled = (
  count: number,
  warnAt: number,
  failAt: number,
  what: string,
): Verdict => {
  const note = `${count} ${what}`;
  if (count >= failAt) return { goodness: 0, note, status: "FAIL" };
  if (count >= warnAt) return { goodness: 0.5, note, status: "WARN" };
  return { goodness: 1, note, status: "PASS" };
};

/** The first few findings, so a note stays readable on one line. */
const firstNotes = <Finding>(
  findings: Finding[],
  text: (finding: Finding) => string,
): string => {
  const shown = findings.slice(0, 3).map(text).join("; ");
  const extra = findings.length - Math.min(findings.length, 3);
  return extra > 0 ? `${shown}; +${extra} more` : shown;
};

/** A verdict that fails on whatever a repo rule flags, or passes clean. */
const findingsVerdict = <Finding extends { line: number }>(
  found: Finding[],
  describe: (finding: Finding) => string,
  passNote: string,
): Verdict =>
  found.length === 0
    ? { goodness: 1, note: passNote, status: "PASS" }
    : { goodness: 0, note: firstNotes(found, describe), status: "FAIL" };

/** One rule finding as a note reads it: its line, then its words. */
const atLine = (finding: { line: number }, words: string): string =>
  `line ${finding.line}: ${words}`;

/** A check body that fails on whatever one repo rule flags. */
const ruleCheck =
  (
    rule: (file: string, content: string) => PerFileFinding[],
    passNote: (facts: CodeFacts) => string,
  ): ((facts: CodeFacts) => Verdict) =>
  (facts) =>
    findingsVerdict(
      rule(facts.file, facts.content),
      (issue) => atLine(issue, issue.problem),
      passNote(facts),
    );

/** What one mechanical check carries; its engine is added at assembly. */
type MechanicalCheck = Omit<CheckEntry, "engine"> & {
  fn: (facts: CodeFacts, ctx: GradeContext) => Verdict;
};

const MECHANICAL_CHECKS: MechanicalCheck[] = [
  {
    fn: (facts, ctx) => {
      const recorded = ctx.overLimit[facts.file];
      if (facts.lines <= 400) {
        return { goodness: 1, note: `${facts.lines} lines`, status: "PASS" };
      }
      if (recorded !== undefined && facts.lines <= recorded) {
        return {
          goodness: 0.5,
          note: `${facts.lines} lines, accepted debt (recorded ${recorded})`,
          status: "WARN",
        };
      }
      return {
        goodness: 0,
        note: `${facts.lines} lines, over the 400-line aim`,
        status: "FAIL",
      };
    },
    id: "file_length",
    label: "File under ~400 lines",
    weight: 5,
  },
  {
    fn: (facts) =>
      scaled(
        findCommentIssues(facts.content, LIMITS).length,
        1,
        2,
        "over-limit comments",
      ),
    id: "comment_limits",
    label: "Comments within limits",
    weight: 3,
  },
  {
    critical: true,
    fn: (facts, ctx) =>
      findingsVerdict(
        findImportIssues(facts.file, facts.content, ctx.aliases),
        (issue) => atLine(issue, issue.message),
        `${facts.imports.length} imports`,
      ),
    id: "imports_one_way",
    label: "Imports name a module one way",
    weight: 4,
  },
  {
    critical: true,
    fn: ruleCheck(findAliasExportIssues, () => "none"),
    id: "alias_exports",
    label: "No alias exports",
    weight: 4,
  },
  {
    critical: true,
    fn: ruleCheck(
      findEmptyCatchIssues,
      (facts) => `${facts.catchClauses.length} catches`,
    ),
    id: "empty_catch",
    label: "No empty catch",
    weight: 5,
  },
  {
    fn: (facts) => {
      if (facts.sql.length === 0) {
        return { goodness: 0, note: "no SQL in file", status: "SKIP" };
      }
      const star = facts.sql.find((statement) =>
        /\bSELECT\s+\*/i.test(statement),
      );
      return star === undefined
        ? {
            goodness: 1,
            note: `${facts.sql.length} statements`,
            status: "PASS",
          }
        : {
            goodness: 0,
            note: "a statement selects every column",
            status: "FAIL",
          };
    },
    id: "select_star",
    label: "No SELECT *",
    weight: 4,
  },
  {
    fn: (facts) => scaled(facts.forEachCalls.length, 1, 3, "forEach calls"),
    id: "forEach_loops",
    label: "No forEach plumbing",
    weight: 2,
  },
  {
    fn: (facts) =>
      scaled(
        facts.nonNullAssertions.length + facts.asCasts.length,
        1,
        3,
        `assertions (${facts.nonNullAssertions.length}) and casts (${facts.asCasts.length})`,
      ),
    id: "assertions_and_casts",
    label: "Few assertions and casts",
    weight: 3,
  },
  {
    fn: (facts) =>
      scaled(facts.missingReturnTypes.length, 1, 2, "without a return type"),
    id: "return_types",
    label: "Exported functions state return types",
    weight: 3,
  },
];

const asCheckEntry = (question: JevQuestion): CheckEntry => ({
  engine: "jev",
  id: question.id,
  label: question.label,
  question: {
    criteria: question.criteria,
    instructions: question.instructions,
    type: "score",
  },
  weight: question.weight,
  ...(question.requires ? { requires: question.requires } : {}),
});

/** Every check the grader knows, mechanical first, then judgement. */
export const CHECKS: CheckEntry[] = [
  ...MECHANICAL_CHECKS.map(
    (check): CheckEntry => ({ ...check, engine: "code" }),
  ),
  ...JEV_QUESTIONS.map(asCheckEntry),
];

/** The checks that apply to one file. */
export const activeChecks = (facts: CodeFacts): CheckEntry[] =>
  CHECKS.filter((check) => !check.requires || check.requires(facts));

/** Run every mechanical check that applies to the file. */
export const runMechanical = (
  facts: CodeFacts,
  ctx: GradeContext,
): Record<string, MechanicalCheckResult> => {
  const results: Record<string, MechanicalCheckResult> = {};
  for (const check of activeChecks(facts)) {
    if (check.engine !== "code" || check.fn === undefined) continue;
    results[check.id] = {
      ...check.fn(facts, ctx),
      critical: check.critical === true,
      engine: "code",
      label: check.label,
      weight: check.weight,
    };
  }
  return results;
};
