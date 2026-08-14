import { assert } from "@std/assert";
import {
  type ConfirmedRefund,
  confirmRefund,
  type RefundConfirmation,
} from "#routes/admin/refunds/confirmation.ts";
import { queryOne } from "#shared/db/client.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import {
  finalizeProcessedPayment,
  refundReferencesFor,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { withTestSession } from "#test-utils/session.ts";

export type PaymentFixture = {
  paymentReference: string;
  sessionId: string;
};

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

export type ConfirmationFixture = ConfirmedRefund & {
  attendeeName: string;
  privateKey: CryptoKey;
  reference: TaggedReference;
  references: TaggedReference[];
  sessionId: string;
};

export const DEFAULT_PAYMENT: PaymentFixture = {
  paymentReference: "pi_confirm_refund",
  sessionId: "sess-confirm-refund",
};

export const confirmFixturePayment = (
  refund: ConfirmationFixture,
): Promise<RefundConfirmation> =>
  withTestSession(() =>
    confirmRefund({ ...refund, references: [refund.reference] })
  );

export const confirmFixturePaymentAndReplay = async (
  refund: ConfirmationFixture,
): Promise<[RefundConfirmation, RefundConfirmation]> => [
  await confirmFixturePayment(refund),
  await confirmFixturePayment(refund),
];

export const setupConfirmation = async (
  payments: readonly PaymentFixture[] = [DEFAULT_PAYMENT],
): Promise<ConfirmationFixture> => {
  const [first, ...later] = payments;
  assert(first !== undefined, "confirmation setup needs a payment");
  const listing = await createTestListing();
  const attendee = bookedAttendee(
    await bookAttendee(listing, {
      email: "buyer@example.com",
      name: "Buyer",
    }),
  );
  await finalizeProcessedPayment(
    first.sessionId,
    attendee.id,
    "tok",
    taggedPaymentReference(first.paymentReference),
  );
  await Promise.all(
    later.map((payment) =>
      finalizeProcessedPayment(
        payment.sessionId,
        attendee.id,
        `tok-${payment.sessionId}`,
        taggedPaymentReference(payment.paymentReference),
      )
    ),
  );
  const privateKey = await getTestPrivateKey();
  const loaded = await refundReferencesFor(attendee.id, privateKey);
  assert(loaded !== undefined, "payment references were omitted");
  const references: TaggedReference[] = loaded.map((reference) => {
    assert(reference.kind === "tagged", "the payment provider was not stored");
    return reference;
  });
  const [reference] = references;
  assert(reference !== undefined, "no payment reference was found");
  const claimed = await claimCurrentAttendeeRows([attendee.id]);
  assert(claimed.kind === "claimed", "the claim was refused");
  const claim = {
    commandId: claimed.commandId,
    held: claimed.held,
    heldSince: claimed.heldSince,
    phases: claimed.phases,
  };
  return {
    attendee: { id: attendee.id },
    attendeeName: attendee.name,
    claim,
    listingId: listing.id,
    paymentOnly: true,
    privateKey,
    reference,
    references,
    sessionId: reference.rowSessionIds[0],
  };
};

export const confirmationCount = async (
  attendeeId: number,
): Promise<number> => {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM refund_confirmations AS confirmation
      WHERE confirmation.attendee_id = ?`,
    [attendeeId],
  );
  assert(row !== null, "refund confirmation count was not found");
  return row.count;
};
