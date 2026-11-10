/** The reviewed false positives. A rule names one file, one owner path, the
 *  mechanism, and the production evidence the scan cannot follow. The gate
 *  builds the field exemptions from the rules and the report, so no rule lists
 *  a field. */

import * as v from "valibot";
import {
  manifestReader,
  ownerPathSchema,
} from "#scripts/unread-fields/manifest.ts";
import {
  EXEMPTION_KINDS,
  type ExemptionRule,
  reasonFor,
} from "#scripts/unread-fields/policy.ts";
import rulesJson from "./exemptions.json" with { type: "json" };

/** The manifest entry of one rule. An unknown key is an error, never a rule
 *  that quietly covers more than its reviewer saw. */
const ruleSchema = v.strictObject({
  evidence: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty("A rule must name the production evidence that the scan misses"),
  ),
  kind: v.picklist(EXEMPTION_KINDS),
  path: ownerPathSchema("rule"),
});

/** Read one manifest into the rules the gate uses. */
export const parseExemptionRules: (manifest: unknown) => ExemptionRule[] =
  manifestReader("rule", "rule", ruleSchema, (exportedFrom, rule) => [
    {
      exportedFrom,
      path: rule.path,
      reason: reasonFor(rule.kind)(rule.evidence),
    },
  ]);

export const UNREAD_FIELD_EXEMPTION_RULES: readonly ExemptionRule[] =
  parseExemptionRules(rulesJson);
