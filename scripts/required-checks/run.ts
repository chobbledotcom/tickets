/**
 * Compares the merge queue's required status checks with the manifest at
 * scripts/required-checks/checks.json. The real list lives in repository
 * Settings, which no pull request can edit, so the manifest is the only
 * reviewable record of the gate and this comparison is the only thing that
 * notices when the two drift apart (issue #2671).
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import { uniqueNamesSchema } from "#scripts/unique-names.ts";

/* jscpd:ignore-end */

/** One required status check, as the branch rules API reports it. */
interface RequiredStatusCheck {
  context: string;
}

/** One active branch rule. Only the status-check rule carries a check list. */
export interface BranchRule {
  parameters?:
    | {
        required_status_checks?: RequiredStatusCheck[] | undefined;
      }
    | undefined;
  type: string;
}

/** The manifest: one name per required status check. */
export const manifestSchema = uniqueNamesSchema("The manifest");

/** Every active rule for a branch, in the shape the rules API returns. */
export const branchRulesSchema: v.GenericSchema<unknown, BranchRule[]> =
  v.array(
    v.object({
      parameters: v.optional(
        v.object({
          required_status_checks: v.optional(
            v.array(v.object({ context: v.string() })),
          ),
        }),
      ),
      type: v.string(),
    }),
  );

/** The names the rules actually require, in alphabetical order. */
export const requiredContexts = (rules: unknown): string[] =>
  [
    ...new Set(
      v
        .parse(branchRulesSchema, rules)
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context),
    ),
  ].sort();

/**
 * The check names that differ between manifest and ruleset, as report lines.
 * A renamed context appears twice: once missing, once extra.
 */
export const driftFindings = (input: {
  expected: string[];
  required: string[];
}): string[] => {
  const wanted = [...new Set(input.expected)].sort();
  const live = [...new Set(input.required)].sort();
  const missing = wanted
    .filter((name) => !live.includes(name))
    .map(
      (name) =>
        `"${name}" is in the manifest but the main ruleset does not require it — add the required status check in repository Settings, or remove it from the manifest.`,
    );
  const extra = live
    .filter((name) => !wanted.includes(name))
    .map(
      (name) =>
        `"${name}" is required by the main ruleset but missing from the manifest — add it to the manifest, or remove the required status check in repository Settings.`,
    );
  return [...missing, ...extra].map((problem) =>
    formatFinding({ problem, rule: "required-check" }),
  );
};

const formatFinding = (finding: { problem: string; rule: string }): string =>
  `scripts/required-checks/checks.json [${finding.rule}]: ${finding.problem}`;

/** Report the drift between manifest and ruleset, and return the exit code. */
export const runRequiredChecksCheck = (input: {
  expected: string[];
  output: CheckOutput;
  rules: unknown;
}): number =>
  reportCheck({
    found: driftFindings({
      expected: input.expected,
      required: requiredContexts(input.rules),
    }),
    guide: "the manifest at scripts/required-checks/checks.json (issue #2671)",
    log: input.output.log,
    logError: input.output.logError,
    noun: "required-check",
    success: "The main ruleset requires exactly the checks the manifest lists.",
  });
