import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, requireOne } from "#shared/db/client.ts";
import type { PaymentReferenceProviderBindingRequest } from "#shared/db/payment-reference-provider.ts";
import {
  loadPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";
import { readRowState } from "#shared/payment/row-state.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

type StoredPaymentRow = {
  failure_data: EnvKeyEncrypted | "";
  payment_reference: string;
  payment_reference_index: string;
  provider_refunded_at: string;
};

export const rowFor = (sessionId: string): Promise<StoredPaymentRow> =>
  requireOne<StoredPaymentRow>(
    `SELECT failure_data, payment_reference, payment_reference_index,
            provider_refunded_at
       FROM processed_payments
      WHERE payment_session_id = ?`,
    [sessionId],
  );

export const legacyBooking = async (
  sessionId: string,
  reference: string,
): Promise<number> => {
  const listing = await createTestListing();
  const attendee = bookedAttendee(
    await bookAttendee(listing, {
      email: `${sessionId}@example.com`,
      name: sessionId,
    }),
  );
  await finalizeProcessedPayment(sessionId, attendee.id, "tok", {
    kind: "untagged",
    reference,
  });
  return attendee.id;
};

export const taggedBooking = async (
  sessionId: string,
  reference: Extract<PaymentReference, { kind: "tagged" }>,
): Promise<number> => {
  const attendeeId = await legacyBooking(sessionId, reference.reference);
  const stored = await storePaymentReference(reference);
  await execute(
    `UPDATE processed_payments
        SET payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ?`,
    [stored.encrypted, stored.index, sessionId],
  );
  return attendeeId;
};

export const bindingRequest = (
  held: Extract<
    Awaited<ReturnType<typeof claimCurrentAttendeeRows>>,
    { kind: "claimed" }
  >,
  bindings: PaymentReferenceProviderBindingRequest["bindings"],
  capability: PaymentReferenceProviderBindingRequest["capability"] = "keyed",
): PaymentReferenceProviderBindingRequest => ({
  bindings,
  capability,
  held: held.held,
  heldSince: held.heldSince,
});

export const loadedReference = async (
  sessionId: string,
): Promise<PaymentReference> =>
  loadPaymentReference(
    (await rowFor(sessionId)).payment_reference,
    await getTestPrivateKey(),
    `payment row ${sessionId}`,
  );

export const claimCapability = async (sessionId: string): Promise<string> => {
  const stored = (await rowFor(sessionId)).failure_data;
  if (stored === "") throw new Error("the claim slot was empty");
  const state = readRowState(
    await decrypt(stored),
    "processed_payments.failure_data",
  );
  if (state.claim === undefined) throw new Error("the claim was not stored");
  return state.claim.capability;
};
