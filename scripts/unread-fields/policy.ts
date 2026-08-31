import type { Step } from "#scripts/unread-fields/fields/steps.ts";
import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

export type ExemptionKind =
  | "dynamic-read"
  | "external-output"
  | "persisted-format"
  | "provider-input"
  | "schema-driven";

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

export type FieldSnapshotChoice = "check" | "exempt";

/** A finite string-key shape whose every field needs an explicit choice. */
export type ClosedFieldSnapshot<Shape> = string extends keyof Shape
  ? never
  : Exclude<keyof Shape, string> extends never
    ? {
        readonly [Field in keyof Shape]-?: FieldSnapshotChoice;
      }
    : never;

/** Classify every field of one finite exported type. New fields stop the type
 * check until their policy is explicit. */
export const exemptFieldsAt =
  <Shape>(
    exportedFrom: string,
    path: readonly Step[],
    reason: ExemptionReason,
  ): ((snapshot: ClosedFieldSnapshot<Shape>) => FindingExemption[]) =>
  (snapshot) =>
    identitiesAt(
      exportedFrom,
      path,
    )(
      Object.entries(snapshot)
        .filter(([, choice]) => choice === "exempt")
        .map(([field]) => field),
    ).map((identity) => ({ identity, reason }));
