/** What a stored payment may be — the rules about how it behaves, as plain
 *  functions over plain data. The tables keep only what is true of a value
 *  whatever the code does; these change as the runtime is written. */

/* jscpd:ignore-start -- imports */
import type { PaymentSessionState } from "#shared/payment-state/lifecycle.ts";
import type { PaymentMode } from "#shared/payment-state/observation.ts";
import type { Fault } from "#shared/payment-state/record/fault.ts";
import {
  absent,
  allAbsent,
  firstFault,
  present,
} from "#shared/payment-state/record/fault.ts";
import type { PaymentProviderType } from "#shared/types.ts";
/* jscpd:ignore-end */

/** A stored payment, in the shape the tables hold it. */
export type StoredPayment = {
  origin: "current" | "legacy";
  provider: PaymentProviderType | null;
  mode: PaymentMode | null;
  accountId: string | null;
  expectedAmount: number | null;
  expectedCurrency: string | null;
  bookingIntent: string | null;
  checkoutCreate: string | null;
  sessionResource: string | null;
  sessionReferenceIndex: string | null;
  state: PaymentSessionState;
  nextReconcileAt: number | null;
  leaseToken: string | null;
  resultState: "none" | "succeeded" | "failed";
  result: string | null;
  ticketState: "none" | "ready" | "consumed";
  ticketTokens: string | null;
  completionState: "none" | "pending" | "completed" | "legacy_unknown";
  completion: string | null;
  legacyRuntime: string | null;
};

/** Tickets and the work after payment are held the same way either side. */
const paymentBookkeepingHolds = (
  payment: StoredPayment,
): [boolean, string][] => [
  [
    (payment.ticketState === "ready") === present(payment.ticketTokens),
    "A payment has its tickets exactly when it says they are ready",
  ],
];

/** The six things a payment made here knows about itself. A copied one knows
 *  none of them: which provider took an old payment is the owner's to say, so
 *  the record must not invent one. */
const whatAPaymentMadeHereKnows = (payment: StoredPayment): unknown[] => [
  payment.provider,
  payment.mode,
  payment.accountId,
  payment.expectedAmount,
  payment.expectedCurrency,
  payment.bookingIntent,
];

/** A payment is either made here or copied across, never a mix. */
export const paymentKnowsWhereItCameFrom = (payment: StoredPayment): Fault => {
  if (payment.origin === "legacy") {
    return firstFault([
      [
        present(payment.legacyRuntime),
        "A payment copied across must keep the old record it came from",
      ],
      [
        allAbsent([
          ...whatAPaymentMadeHereKnows(payment),
          payment.checkoutCreate,
          payment.sessionResource,
          payment.sessionReferenceIndex,
        ]),
        "A payment copied across never knew who took the money, or what for",
      ],
      [
        (payment.resultState === "none" && absent(payment.result)) ||
          (payment.resultState === "succeeded" &&
            absent(payment.result) &&
            payment.state === "completed") ||
          (payment.resultState === "failed" &&
            present(payment.result) &&
            payment.state === "failed"),
        "How a copied payment turned out must agree with where it got to",
      ],
      ...paymentBookkeepingHolds(payment),
      [
        ["none", "legacy_unknown"].includes(payment.completionState) &&
          absent(payment.completion),
        "A payment copied across never recorded the work done after it",
      ],
      [
        payment.completionState !== "legacy_unknown" ||
          payment.state === "completed",
        "Only a completed copied payment can have work nobody knows about",
      ],
    ]);
  }
  return firstFault([
    [
      absent(payment.legacyRuntime),
      "A payment made here has no old record to carry",
    ],
    [
      whatAPaymentMadeHereKnows(payment).every(present),
      "A payment made here knows who takes the money, how much, and what for",
    ],
    [
      absent(payment.checkoutCreate) ||
        (absent(payment.sessionResource) && payment.state === "created"),
      "What the provider was asked to build is kept only until it exists",
    ],
    [
      present(payment.sessionResource) ||
        ["created", "failed"].includes(payment.state),
      "A payment past its start must know the checkout it belongs to",
    ],
    [
      (payment.resultState === "none") === absent(payment.result),
      "A payment has its result exactly when it says it has one",
    ],
    ...paymentBookkeepingHolds(payment),
    [
      (payment.completionState === "none") === absent(payment.completion),
      "A payment has its after-work exactly when it says there is some",
    ],
    [
      payment.completionState !== "pending" || present(payment.nextReconcileAt),
      "Work still to do must be booked in to be looked at again",
    ],
    [
      payment.completionState !== "legacy_unknown",
      "Only a payment copied across can have work nobody knows about",
    ],
  ]);
};

/** When a buyer's details may be cleared from a payment. */
export const readyToClearBuyerDetails = (payment: StoredPayment): Fault =>
  firstFault([
    [absent(payment.leaseToken), "Someone still holds this payment"],
    [
      absent(payment.nextReconcileAt),
      "This payment is still booked in to be looked at",
    ],
    [payment.ticketState !== "ready", "A ticket still needs these details"],
    [
      payment.origin === "legacy"
        ? ["completed", "failed", "fully_refunded"].includes(payment.state)
        : payment.state === "failed" ||
          (["completed", "fully_refunded"].includes(payment.state) &&
            payment.completionState === "completed"),
      "This payment is not over yet",
    ],
  ]);
