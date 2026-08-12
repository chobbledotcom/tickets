import { assert } from "@std/assert";
import type { ConfirmedRefund } from "#routes/admin/refunds/confirmation.ts";
import { queryOne } from "#shared/db/client.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
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

export type PaymentFixture = {
  paymentReference: string;
  sessionId: string;
};

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

export type ConfirmationFixture = ConfirmedRefund & {
  privateKey: CryptoKey;
  reference: TaggedReference;
  references: TaggedReference[];
  sessionId: string;
};

export const DEFAULT_PAYMENT: PaymentFixture = {
  paymentReference: "pi_confirm_refund",
  sessionId: "sess-confirm-refund",
};

export const setupConfirmation = async (
  payments: readonly PaymentFixture[] = [DEFAULT_PAYMENT],
  options: {
    beforeClaim?: (attendee: Attendee) => Promise<void>;
    paymentId?: string;
  } = {},
): Promise<ConfirmationFixture> => {
  const [first, ...later] = payments;
  assert(first !== undefined, "confirmation setup needs a payment");
  const listing = await createTestListing();
  const attendee = bookedAttendee(
    await bookAttendee(listing, {
      email: "buyer@example.com",
      name: "Buyer",
      ...(options.paymentId === undefined
        ? {}
        : { paymentId: options.paymentId }),
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
      ),
    ),
  );
  if (options.beforeClaim) await options.beforeClaim(attendee);
  const privateKey = await getTestPrivateKey();
  const loaded = await refundReferencesFor(attendee.id, privateKey);
  assert(loaded !== undefined, "payment references were omitted");
  const references = loaded.map((reference) => {
    assert(
      reference.kind === "tagged",
      "an untagged payment reference was loaded",
    );
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
    phases: new Map(
      [...claimed.phases].map(([sessionId]) => [sessionId, "ready" as const]),
    ),
  };
  const bound = await bindPaymentReferenceProviders({
    bindings: new Map(
      references.map((boundReference) => [
        boundReference.index,
        {
          capability: "keyed" as const,
          identity: {
            kind: "tagged" as const,
            provider: boundReference.provider,
            reference: boundReference.reference,
          },
        },
      ]),
    ),
    ...claim,
  });
  assert(bound.kind === "bound", "the provider was not bound");
  return {
    attendee: { id: attendee.id, name: attendee.name },
    claim,
    listingId: listing.id,
    paymentOnly: true,
    privateKey,
    reference,
    references,
    sessionId: first.sessionId,
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
