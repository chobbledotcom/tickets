import type { corruptSplitData } from "#scripts/verify-models/largest-remainder-split.ts";
import {
  type CheckPhase,
  dataFrom,
  type ModelControl,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { SUBSCRIPTION_MODULES } from "#scripts/verify-models/subscriptions/registry.ts";

const vat = dataFrom(() => import("#scripts/verify-models/vat.ts"));
const square = dataFrom(() => import("#scripts/verify-models/square.ts"));
const sumup = dataFrom(() => import("#scripts/verify-models/sumup.ts"));
const review = dataFrom(() => import("#scripts/verify-models/review.ts"));
const split = dataFrom(
  () => import("#scripts/verify-models/largest-remainder-split.ts"),
);
const composition = dataFrom(
  () => import("#scripts/verify-models/checkout-composition.ts"),
);
const compositionControls = dataFrom(
  () => import("#scripts/verify-models/composition-corruptions.ts"),
);
const payment = dataFrom(() => import("#scripts/verify-models/model.ts"));
const paymentControl = dataFrom(
  () => import("#scripts/verify-models/counterexample.ts"),
);
const booking = dataFrom(() => import("#scripts/verify-models/booking.ts"));
const workers = dataFrom(() => import("#scripts/verify-models/two-workers.ts"));
const notification = dataFrom(
  () => import("#scripts/verify-models/notification-flag-lease.ts"),
);
const door = dataFrom(() => import("#scripts/verify-models/door-scan.ts"));
const group = dataFrom(
  () => import("#scripts/verify-models/shared-group-capacity.ts"),
);
const capacity = dataFrom(
  () => import("#scripts/verify-models/attendee-capacity.ts"),
);
const reversal = dataFrom(
  () => import("#scripts/verify-models/refund-reversal.ts"),
);
const invoiceFlow = dataFrom(
  () => import("#scripts/verify-models/invoice-flow.ts"),
);

const splitControl = (
  corruption: Parameters<typeof corruptSplitData>[0],
  name: string,
  phase: CheckPhase,
): ModelControl => ({
  data: split((m) => () => m.corruptSplitData(corruption)),
  name,
  phase,
});

/** The source inventory, review context, and checks share this declaration. */
export const VERIFICATION_MODULES = [
  { context: [], kind: "helper", module: "ModelRules" },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/vat.ts",
      "src/shared/tax/assessment.ts",
      "src/shared/tax/machine-spec.ts",
    ],
    controls: [
      {
        data: vat((m) => m.corruptVatData),
        name: "a changed historical assessment",
        phase: "step",
      },
    ],
    data: vat((m) => m.vatModelData),
    kind: "model",
    module: "VatLedger",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/square.ts",
      "src/shared/payment/square-link-end-machine-spec.ts",
      "src/shared/square/link-end.ts",
    ],
    controls: [
      {
        data: square((m) => m.corruptSquareData),
        name: "a payable link without its handle",
        phase: "step",
      },
    ],
    data: square((m) => m.squareModelData),
    kind: "model",
    module: "SquareLinkEnd",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/sumup.ts",
      "src/shared/payment/sumup-recovery-machine-spec.ts",
    ],
    controls: [
      {
        data: sumup((m) => m.corruptSumupData),
        name: "lost checkout identity",
        phase: "step",
      },
    ],
    data: sumup((m) => m.sumupModelData),
    kind: "model",
    module: "SumupRecovery",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/review.ts",
      "src/shared/payment/review-machine-spec.ts",
    ],
    controls: [
      {
        data: review((m) => m.corruptReviewData),
        name: "changed review case identity",
        phase: "step",
      },
    ],
    data: review((m) => m.reviewModelData),
    kind: "model",
    module: "PaymentReview",
  },
  {
    context: [
      "scripts/verify-models/largest-remainder-split.ts",
      "src/shared/largest-remainder.ts",
      "src/shared/reservation-amount.ts",
    ],
    controls: [
      splitControl("cap guard", "an award past its cap", "step"),
      splitControl("unconserved accounting", "a stranded owed unit", "step"),
      splitControl(
        "negative accounting",
        "negative outstanding money",
        "initial",
      ),
    ],
    data: split((m) => m.largestRemainderSplitModelData),
    kind: "model",
    module: "LargestRemainderSplit",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/checkout-composition.ts",
      "scripts/verify-models/composition-corruptions.ts",
      "src/shared/checkout-pricing.ts",
      "src/shared/price-modifier.ts",
      "src/shared/booking-fee.ts",
    ],
    controls: [
      {
        data: compositionControls((m) => m.compoundingDiscountData),
        name: "a compounding modifier",
        phase: "step",
      },
      {
        data: compositionControls((m) => m.overshootDiscountData),
        name: "an overshooting discount",
        phase: "step",
      },
      {
        data: compositionControls((m) => m.staleFeeData),
        name: "a stale fee-basis fact",
        phase: "step",
      },
    ],
    data: composition((m) => m.checkoutCompositionModelData),
    kind: "model",
    module: "CheckoutComposition",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/model.ts",
      "scripts/verify-models/counterexample.ts",
      "src/shared/payment/refund-authority.ts",
    ],
    controls: [
      {
        data: paymentControl((m) => m.counterexampleData),
        name: "a corrupted refund edge",
        phase: "step",
      },
    ],
    data: payment((m) => async () => m.modelData(await m.paymentModel())),
    kind: "model",
    module: "JointState",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/booking.ts",
      "src/shared/session-ledger.ts",
    ],
    controls: [
      {
        data: booking((m) => m.duplicateBookingData),
        name: "a duplicate booking",
        phase: "step",
      },
      {
        data: booking((m) => m.deletedRowRefundData),
        name: "a refund after temporary-row deletion",
        phase: "step",
      },
    ],
    data: booking((m) => m.bookingReplayModelData),
    kind: "model",
    module: "BookingReplay",
  },
  {
    context: [
      "scripts/verify-models/two-workers.ts",
      "src/shared/payment/claim.ts",
      "src/shared/payment/row-transitions.ts",
    ],
    controls: [
      {
        data: workers((m) => m.corruptSettleData),
        name: "a stale worker releasing a replacement claim",
        phase: "initial",
      },
    ],
    data: workers((m) => m.twoWorkersModelData),
    kind: "model",
    module: "TwoWorkers",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/notification-flag-lease.ts",
      "src/shared/db/attendees/notification-flags.ts",
    ],
    controls: [
      {
        data: notification((m) => m.corruptClaimWithoutCaptureData),
        name: "a claim without capture",
        phase: "step",
      },
      {
        data: notification((m) => m.corruptRestoreColourData),
        name: "an invented restore colour",
        phase: "step",
      },
    ],
    data: notification((m) => m.notificationFlagLeaseModelData),
    kind: "model",
    module: "NotificationFlagLease",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/door-scan.ts",
      "src/features/admin/scan-decision.ts",
    ],
    controls: [
      {
        data: door((m) => m.corruptDoorScanData),
        name: "over-admission",
        phase: "step",
      },
      {
        data: door((m) => m.takeBackDoorScanData),
        name: "a place taken back",
        phase: "step",
      },
      {
        data: door((m) => m.refundedAdmissionDoorScanData),
        name: "admission of a refunded row",
        phase: "step",
      },
    ],
    data: door((m) => m.doorScanModelData),
    kind: "model",
    module: "DoorScan",
  },
  {
    context: [
      "scripts/verify-models/shared-group-capacity.ts",
      "src/shared/group-capacity.ts",
      "src/shared/booking/model.ts",
    ],
    controls: [
      {
        data: group((m) => m.overfillCapacityData),
        name: "group overfill",
        phase: "initial",
      },
      {
        data: group((m) => m.dateLessSoldOutPairData),
        name: "a sold-out date-less pair",
        phase: "initial",
      },
    ],
    data: group((m) => m.sharedGroupCapacityModelData),
    kind: "model",
    module: "SharedGroupCapacity",
  },
  {
    context: [
      "scripts/verify-models/attendee-capacity.ts",
      "scripts/verify-models/attendee-capacity-seed.ts",
      "scripts/verify-models/schema-client.ts",
      "src/shared/db/attendees/atomic-update.ts",
      "src/shared/db/capacity.ts",
    ],
    controls: [
      {
        data: capacity((m) => m.overfillInsertData),
        name: "an insert past capacity",
        phase: "initial",
      },
      {
        data: capacity((m) => m.partialCommitData),
        name: "a partial batch commit",
        phase: "initial",
      },
    ],
    data: capacity((m) => m.attendeeCapacityModelData),
    kind: "model",
    module: "AttendeeCapacity",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/refund-reversal.ts",
      "src/shared/refund-ledger/plan.ts",
      "src/shared/ledger/reverse.ts",
    ],
    controls: [
      {
        data: reversal((m) => m.operatorMoneyReversalData),
        name: "an operator-money reversal",
        phase: "step",
      },
      {
        data: reversal((m) => m.nonInverseLegData),
        name: "a non-inverse refund leg",
        phase: "step",
      },
      {
        data: reversal((m) => m.unpairedLegData),
        name: "an unpaired refund leg",
        phase: "step",
      },
      {
        data: reversal((m) => m.doubleRecordData),
        name: "a double refund record",
        phase: "step",
      },
    ],
    data: reversal((m) => m.refundReversalModelData),
    kind: "model",
    module: "RefundReversal",
  },
  {
    context: [
      "verification/ModelRules.tla",
      "scripts/verify-models/invoice-flow.ts",
      "scripts/verify-models/schema-client.ts",
      "src/shared/db/invoices.ts",
      "src/shared/db/migrations/schema/tables-invoices.ts",
    ],
    controls: [
      {
        data: invoiceFlow((m) => m.secondOpenInvoiceData),
        name: "a second open invoice",
        phase: "step",
      },
      {
        data: invoiceFlow((m) => m.reopenedInvoiceData),
        name: "a reopened invoice",
        phase: "step",
      },
    ],
    data: invoiceFlow((m) => m.invoiceFlowModelData),
    kind: "model",
    module: "InvoiceFlow",
  },
  ...SUBSCRIPTION_MODULES,
] as const satisfies readonly VerificationModule[];

/** A maintained source must declare its role before the tools can assess it. */
export const verificationModuleFor = (file: string): VerificationModule => {
  const declaration = VERIFICATION_MODULES.find(
    (entry) => file === `verification/${entry.module}.tla`,
  );
  if (declaration === undefined) {
    throw new Error(`The TLA source has no declaration: ${file}`);
  }
  return declaration;
};
