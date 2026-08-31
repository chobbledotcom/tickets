import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import type { FindingIdentity } from "#scripts/unread-fields/identity.ts";
import type { FindingExemption } from "#scripts/unread-fields/policy.ts";
import {
  formatUnreadFieldProblem,
  reconcileUnreadFields,
} from "#scripts/unread-fields/reconcile.ts";

export interface UnreadFieldsCheckDeps {
  baseline: readonly FindingIdentity[];
  exemptions: readonly FindingExemption[];
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
    deps.exemptions,
  )(findings).map(formatUnreadFieldProblem);
  return reportCheck({
    ...output,
    found,
    guide: "scripts/unread-fields/README.md",
    noun: "unread-field",
    success:
      "Every reported unread field matches one exact policy entry, and every policy entry is current.",
  });
};
