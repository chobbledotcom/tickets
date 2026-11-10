/** The reviewed false positives. A rule names one file, one owner path, the
 *  mechanism, and the production evidence the scan cannot follow. The gate
 *  builds the field exemptions from the rules and the report, so no rule lists
 *  a field. */

import * as v from "valibot";
import {
  EXEMPTION_KINDS,
  type ExemptionRule,
  reasonFor,
} from "#scripts/unread-fields/policy.ts";
import rulesJson from "./exemptions.json" with { type: "json" };

const stepSchema = v.union([
  v.object({ name: v.string() }),
  v.object({ way: v.string() }),
]);

const ruleSchema = v.object({
  evidence: v.string(),
  kind: v.picklist(EXEMPTION_KINDS),
  path: v.array(stepSchema),
});

/** The manifest: each source file, with the owner paths it exports. */
const rulesSchema = v.record(v.string(), v.array(ruleSchema));

const rulesFrom = (
  manifest: v.InferOutput<typeof rulesSchema>,
): ExemptionRule[] =>
  Object.entries(manifest).flatMap(([exportedFrom, rules]) =>
    rules.map((rule) => ({
      exportedFrom,
      path: rule.path,
      reason: reasonFor(rule.kind)(rule.evidence),
    })),
  );

export const UNREAD_FIELD_EXEMPTION_RULES: readonly ExemptionRule[] = rulesFrom(
  v.parse(rulesSchema, rulesJson),
);
