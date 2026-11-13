import { bookingEventGroup } from "#accounting/mappers.ts";
import { requirePublicStatusId } from "#db/attendee-statuses.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { queryOnePrimary } from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  advanceSessionFailure,
  type ProcessedPayment,
  parseSessionFailure,
  prepareSessionFailure,
  type ReserveSessionResult,
  releaseReservation,
} from "#db/processed-payments.ts";
import {
  type PlaceholderRefund,
  placeholderRefund,
} from "#payment/placeholder-refund.ts";
import {
  type TaggedPaymentReference,
  taggedPaymentReference,
} from "#payment/provider-reference.ts";
import type { SessionRejection } from "#payment/validated-session.ts";
import { attendeeBaseFields } from "#routes/api/payment-processing/create.ts";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
import {
  type HeldRefundTarget,
  loadRefundResume,
  storedPlaceholderOutcome,
} from "#routes/api/payment-processing/placeholder-resume.ts";
import {
  NOTHING_TO_REFUND,
  ownedRejection,
  type RejectionHandler,
  type RejectionOutcome,
  refundRejectedCharge,
} from "#routes/api/payment-processing/refunds.ts";
import {
  completeRejectedMoney,
  readRejectedAuthority,
} from "#routes/api/payment-processing/rejected-money.ts";
import { withRejectedSession } from "#routes/api/payment-processing/rejected-session.ts";
import {
  datelessGhostBookings,
  storeClaimedPlaceholder,
} from "#routes/api/payment-processing/store-refund.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { requireValue } from "#shared/required-value.ts";
import { withSubscriptionPlan } from "#shared/subscriptions/booking-plan.ts";
import { endFailedCheckoutSubscription } from "#shared/subscriptions/failed-checkout.ts";

type RefundTarget = HeldRefundTarget & {
  reference: TaggedPaymentReference;
};

type RejectedCheckout = {
  intent: BookingIntent;
  occurredAt: string;
  reference: TaggedPaymentReference | null;
  rejection: SessionRejection;
  spec: PlaceholderRefund;
};

const markRejectionRefunded = ({
  rejection,
  spec,
}: RejectedCheckout): Promise<void> =>
  advanceSessionFailure(
    rejection.sessionId,
    storedPlaceholderOutcome(spec, false),
    storedPlaceholderOutcome(spec, true),
  );

type StoredRejection =
  | { kind: "refund"; target: RefundTarget }
  | { kind: "no-charge" }
  | { kind: "settled"; refunded: boolean };

type PlanStore = Pick<
  Parameters<typeof storeClaimedPlaceholder>[0],
  "bookings" | "fields" | "sessionFailure" | "sessionId"
>;

/** A pruned session must not let a malformed replay cancel a real booking. */
const checkoutWasHonoured = async (sessionId: string): Promise<boolean> => {
  const eventGroup = await bookingEventGroup(sessionId);
  const { sql, args } = numberedStatement((bind) => {
    const group = bind(eventGroup);
    return `SELECT 1 WHERE EXISTS (
      SELECT 1 FROM listing_attendees AS booking
       WHERE booking.ledger_event_group = ${group} AND booking.quantity > 0
    ) OR EXISTS (
      SELECT 1 FROM transfers AS transfer
       WHERE transfer.event_group = ${group}
         AND transfer.kind NOT IN ('payment', 'refund_cash')
    )`;
  });
  return (await queryOnePrimary(sql, args)) !== null;
};

const storeNoChargePlan = async (plan: PlanStore): Promise<void> => {
  const stored = await attendeesApi.createAttendeeAtomic(
    { ...plan.fields, allowOverbook: true, bookings: plan.bookings },
    async (tx) => {
      const result = await tx.execute(plan.sessionFailure.statement);
      if (result.rowsAffected !== 1) {
        throw new Error(
          `Rejected subscription session lost its reservation: ${plan.sessionId}`,
        );
      }
    },
  );
  if (!stored.success) {
    throw new Error(
      `Rejected subscription placeholder was refused: ${plan.sessionId}`,
    );
  }
};

const storeRejectedPlan = async (
  work: RejectedCheckout,
): Promise<StoredRejection> => {
  const { intent, reference, rejection, spec } = work;
  const plan: PlanStore = {
    bookings: withSubscriptionPlan(
      datelessGhostBookings(intent.items),
      rejection.subscription,
      requireValue(intent.taxPolicy, "Parsed booking has no tax policy"),
    ),
    fields: attendeeBaseFields(
      reference === null ? "" : reference.reference,
      intent,
      await requirePublicStatusId(),
    ),
    sessionFailure: await prepareSessionFailure(
      rejection.sessionId,
      storedPlaceholderOutcome(spec, false),
    ),
    sessionId: rejection.sessionId,
  };
  if (reference === null) {
    await storeNoChargePlan(plan);
    return { kind: "no-charge" };
  }
  const stored = await storeClaimedPlaceholder({
    ...plan,
    paymentReference: reference,
  });
  return {
    kind: "refund",
    target: {
      attendeeId: stored.attendeeId,
      occurredAt: work.occurredAt,
      reference,
      settlement: stored.claimedAnchor.settlement,
    },
  };
};

const resumeRejectedPlan = async (
  work: RejectedCheckout,
  existing: ProcessedPayment,
): Promise<StoredRejection> => {
  const { reference, rejection } = work;
  if (reference === null) return { kind: "no-charge" };
  const search = await loadRefundResume(
    reference,
    rejection.sessionId,
    () => work.occurredAt,
  );
  if (search.target !== null) {
    return {
      kind: "refund",
      target: {
        ...search.target,
        reference,
      },
    };
  }
  const failure = requireValue(
    await parseSessionFailure(existing.failure_data),
    "Rejected subscription session has no stored failure",
  );
  const refunded =
    failure.refunded === true ||
    search.rows.some((row) => row.refundStateName === "completed");
  if (refunded && failure.refunded !== true) {
    await markRejectionRefunded(work);
  }
  if (search.rows.length === 0) {
    await endFailedCheckoutSubscription(rejection.subscription);
  }
  return { kind: "settled", refunded };
};

const refundStoredRejection = async (
  work: RejectedCheckout,
  target: RefundTarget,
): Promise<RejectionOutcome> => {
  const { intent, rejection, spec } = work;
  const outcome = await refundRejectedCharge(rejection);
  if (outcome.returned === null) return outcome;
  const authority = await readRejectedAuthority(
    outcome.returned,
    rejection.sessionId,
  );
  await completeRejectedMoney({
    authority,
    intent,
    reference: target.reference,
    returned: outcome.returned,
    sessionId: rejection.sessionId,
    spec,
  })(target);
  await markRejectionRefunded(work);
  return outcome;
};

const settleOwnedRejection = async (
  rejection: SessionRejection,
  reservation: ReserveSessionResult,
): Promise<RejectionOutcome> => {
  if (await checkoutWasHonoured(rejection.sessionId)) {
    if (reservation.reserved) await releaseReservation(rejection.sessionId);
    return NOTHING_TO_REFUND;
  }
  const intent = extractIntentFromMetadata(rejection.metadata);
  if (intent === null) {
    if (reservation.reserved) await releaseReservation(rejection.sessionId);
    await endFailedCheckoutSubscription(rejection.subscription);
    return refundRejectedCharge(rejection);
  }
  const work: RejectedCheckout = {
    intent,
    occurredAt: requireValue(
      rejection.createdAt,
      "Stripe subscription checkout has no creation time",
    ),
    reference:
      rejection.reason === "malformed_charge" && rejection.refundable
        ? taggedPaymentReference(rejection.provider, rejection.paymentReference)
        : null,
    rejection,
    spec: placeholderRefund("malformed_charge")(
      `Provider reported subscription session ${rejection.sessionId} in a form the site could not read`,
    ),
  };
  const stored = reservation.reserved
    ? await storeRejectedPlan(work)
    : await resumeRejectedPlan(work, reservation.existing);
  if (stored.kind === "settled") {
    return { ...NOTHING_TO_REFUND, refunded: stored.refunded };
  }
  await endFailedCheckoutSubscription(rejection.subscription);
  return stored.kind === "no-charge"
    ? NOTHING_TO_REFUND
    : refundStoredRejection(work, stored.target);
};

/** A rejected checkout must keep its plan before Stripe stops future charges. */
export const settleRejectedSubscription: RejectionHandler = ownedRejection(
  (rejection) =>
    withRejectedSession(rejection.sessionId, (reservation) => {
      if (!reservation.reserved && reservation.existing.attendee_id !== null) {
        return NOTHING_TO_REFUND;
      }
      if (!reservation.reserved && reservation.existing.failure_data === "") {
        return { ...NOTHING_TO_REFUND, settled: false };
      }
      return settleOwnedRejection(rejection, reservation);
    }),
);
