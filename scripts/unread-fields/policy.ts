import type { Step } from "#scripts/unread-fields/fields/steps.ts";
import {
  type FindingIdentity,
  ownerKey,
} from "#scripts/unread-fields/identity.ts";

/** The five mechanisms a reviewed false positive can name. */
export const EXEMPTION_KINDS = [
  "dynamic-read",
  "external-output",
  "persisted-format",
  "provider-input",
  "schema-driven",
] as const;

export type ExemptionKind = (typeof EXEMPTION_KINDS)[number];

/** Why a field has a real reader that the TypeScript reference scan cannot
 * see. Evidence names the production boundary or consumer. */
export interface ExemptionReason {
  evidence: string;
  kind: ExemptionKind;
}

export interface FindingExemption {
  identity: FindingIdentity;
  reason: ExemptionReason;
}

/** One reviewed false positive: every reported field under this exact owner
 * path has a real reader that the scan cannot see. The report names those
 * fields, so a rule never lists them, and a field the scan reads needs no
 * rule. */
export interface ExemptionRule {
  exportedFrom: string;
  path: readonly Step[];
  reason: ExemptionReason;
}

/** One reason of a kind, carrying the evidence that kind needs. */
export const reasonFor =
  (kind: ExemptionKind) =>
  (evidence: string): ExemptionReason => ({ evidence, kind });

/** The exemptions one rule covers: the reported fields it owns, each with the
 * rule's reason. */
export const exemptionsOf =
  (reported: readonly FindingIdentity[]) =>
  (rule: ExemptionRule): FindingExemption[] => {
    const owner = ownerKey(rule.exportedFrom, rule.path);
    return reported
      .filter(
        (identity) => ownerKey(identity.exportedFrom, identity.path) === owner,
      )
      .map(({ exportedFrom, field, path }) => ({
        identity: { exportedFrom, field, path },
        reason: rule.reason,
      }));
  };
