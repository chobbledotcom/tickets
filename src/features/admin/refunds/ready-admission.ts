import {
  admitObservedRefund,
  type ObservedRefundAdmission,
} from "#payment/admit-refund.ts";
import type { ReadyRefundReference } from "./readiness.ts";

/** Judge one readiness-qualified reference without reading its provider again. */
export const readyRefundAdmission = (
  ready: ReadyRefundReference,
): ObservedRefundAdmission =>
  ready.kind === "already_returned"
    ? { kind: "already_returned" }
    : admitObservedRefund(ready.reference.reference, ready.charge);
