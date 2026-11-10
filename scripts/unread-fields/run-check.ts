import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import type { FindingIdentity } from "#scripts/unread-fields/identity.ts";
import type { ExemptionRule } from "#scripts/unread-fields/policy.ts";
import {
  formatUnreadFieldProblem,
  reconcileUnreadFields,
} from "#scripts/unread-fields/reconcile.ts";

export interface UnreadFieldsCheckDeps {
  baseline: readonly FindingIdentity[];
  rules: readonly ExemptionRule[];
  scan: (root: string) => Promise<Finding[]>;
}

/** Run the scan and compare every reportable field with its exact policy. */
export const runUnreadFieldsCheck = async (
  root: string,
  output: CheckOutput,
  deps: UnreadFieldsCheckDeps,
): Promise<number> => {
  const findings = await deps.scan(root);
  const found = reconcileUnreadFields(
    deps.baseline,
    deps.rules,
  )(findings).map(formatUnreadFieldProblem);
  return reportCheck({
    ...output,
    found,
    guide: "scripts/unread-fields/README.md",
    noun: "unread-field",
    success:
      "Every reported unread field is accepted debt or sits under a current exemption rule.",
  });
};
