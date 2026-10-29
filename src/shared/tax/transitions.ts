/* jscpd:ignore-start */
import { assessTax } from "#shared/tax/assessment.ts";
import type { TaxAssessment, TaxPolicy } from "#shared/tax/types.ts";
/* jscpd:ignore-end */

export type TaxState = {
  kind: "active" | "refunded";
  revision: number;
  assessment: TaxAssessment;
};
export type TaxTransition = {
  kind: "unchanged" | "reassessed";
  before: TaxState;
  after: TaxState;
};

export const sameTaxPolicy = (left: TaxPolicy, right: TaxPolicy): boolean =>
  left.mode === right.mode &&
  (left.mode === "none" ||
    (right.mode !== "none" && left.rateBasisPoints === right.rateBasisPoints));

/** A save uses the original listed basis, never the last tax-adjusted income. */
export const reassessTax = (
  state: TaxState,
  policy: TaxPolicy,
  expectedRevision: number,
): TaxTransition => {
  if (state.revision !== expectedRevision)
    throw new Error("The booking tax assessment changed. Reload the attendee.");
  if (
    state.kind === "refunded" ||
    sameTaxPolicy(state.assessment.policy, policy)
  ) {
    return { after: state, before: state, kind: "unchanged" };
  }
  return {
    after: {
      assessment: assessTax(state.assessment.basis, policy),
      kind: "active",
      revision: state.revision + 1,
    },
    before: state,
    kind: "reassessed",
  };
};

/** A completed refund closes the assessment without a new price calculation. */
export const refundTax = (
  state: TaxState,
  expectedRevision: number,
): TaxState => {
  if (state.revision !== expectedRevision)
    throw new Error("The booking tax assessment changed. Reload the refund.");
  return state.kind === "refunded"
    ? state
    : { ...state, kind: "refunded", revision: state.revision + 1 };
};
