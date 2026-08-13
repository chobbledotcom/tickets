import { assert } from "@std/assert";
import {
  type ConfirmedRefund,
  confirmRefund,
  type RefundConfirmation,
} from "#routes/admin/refunds/confirmation.ts";
import { queryOne } from "#shared/db/client.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import {
  bookAttendee,
  bookedAttendee,
  resaveAttendee,
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
    confirmRefund({ ...refund, references: [refund.reference] }),
  );

export const confirmFixturePaymentAndReplay = async (
  refund: ConfirmationFixture,
): Promise<[RefundConfirmation, RefundConfirmation]> => [
  await confirmFixturePayment(refund),
  await confirmFixturePayment(refund),
];

export const setupConfirmation = async (
  payments: readonly PaymentFixture[] = [DEFAULT_PAYMENT],
  options: {
    anchorOnly?: boolean;
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
  if (options.anchorOnly) {
    assert(
      options.paymentId === first.paymentReference && later.length === 0,
      "an anchor-only confirmation needs its one payment in attendee PII",
    );
    await resaveAttendee(attendee);
  } else {
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
  }
  if (options.beforeClaim) await options.beforeClaim(attendee);
  const privateKey = await getTestPrivateKey();
  const loaded = await refundReferencesFor(attendee.id, privateKey);
  assert(loaded !== undefined, "payment references were omitted");
  const [loadedReference] = loaded;
  assert(loadedReference !== undefined, "no payment reference was found");
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
      loaded.map((boundReference) => [
        boundReference.index,
        {
          capability: "keyed" as const,
          identity: {
            kind: "tagged" as const,
            provider:
              boundReference.kind === "tagged"
                ? boundReference.provider
                : "stripe",
            reference: boundReference.reference,
          },
        },
      ]),
    ),
    ...claim,
  });
  assert(bound.kind === "bound", "the provider was not bound");
  const stored = await refundReferencesFor(attendee.id, privateKey);
  assert(stored !== undefined, "bound payment references were omitted");
  const references: TaggedReference[] = stored.map((storedReference) => {
    assert(
      storedReference.kind === "tagged",
      "the provider binding was not stored",
    );
    return storedReference;
  });
  const [reference] = references;
  assert(reference !== undefined, "the bound reference was not found");
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
