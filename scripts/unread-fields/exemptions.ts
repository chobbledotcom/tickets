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

/** A step is a field's name or the way a reader reaches through a member with
 *  no name. Both carry exactly one of the two words. */
const stepSchema = v.union(
  [v.strictObject({ name: v.string() }), v.strictObject({ way: v.string() })],
  "A step must name a field or the way a reader reaches through it",
);

/** The manifest entry of one rule. An unknown key is an error, never a rule
 *  that quietly covers more than its reviewer saw. */
const ruleSchema = v.strictObject({
  evidence: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty("A rule must name the production evidence that the scan misses"),
  ),
  kind: v.picklist(EXEMPTION_KINDS),
  path: v.pipe(
    v.array(stepSchema),
    v.nonEmpty("A rule must name at least one owner path step"),
  ),
});

/** The manifest: each production source file, with the owner paths it
 *  exports. */
const rulesSchema = v.record(
  v.pipe(
    v.string(),
    v.startsWith("src/", "A rule file must be a path under src/"),
  ),
  v.pipe(v.array(ruleSchema), v.nonEmpty("A file must name at least one rule")),
);

/** Where in the manifest an issue sits, so a reader can go to it. */
const issuePlace = (issue: v.BaseIssue<unknown>): string => {
  const place = (issue.path ?? []).map((item) => String(item.key)).join(" / ");
  return place === "" ? "the top of the manifest" : place;
};

/** Read one manifest into the rules the gate uses. A malformed manifest fails
 *  here, before the scan, and names the entry to repair. */
export const parseExemptionRules = (manifest: unknown): ExemptionRule[] => {
  const result = v.safeParse(rulesSchema, manifest);
  if (!result.success) {
    throw new Error(
      [
        "The unread-field rule manifest is not valid:",
        ...result.issues.map(
          (issue) => `  ${issuePlace(issue)}: ${issue.message}`,
        ),
      ].join("\n"),
    );
  }
  return Object.entries(result.output).flatMap(([exportedFrom, rules]) =>
    rules.map((rule) => ({
      exportedFrom,
      path: rule.path,
      reason: reasonFor(rule.kind)(rule.evidence),
    })),
  );
};

export const UNREAD_FIELD_EXEMPTION_RULES: readonly ExemptionRule[] =
  parseExemptionRules(rulesJson);
