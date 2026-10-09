/** Test-only construction of payment rows written before provider tags existed. */

import { assert } from "@std/assert";
import { hmacHash } from "#crypto/hashing.ts";
import { encryptWithOwnerKey } from "#crypto/hybrid.ts";

import { execute, queryOne } from "#db/client.ts";
import {
  legacyPaymentReferencePage,
  type RebuiltLegacyReferences,
  rebuildLegacyPaymentReferences,
} from "#db/payment-reference-rebuild.ts";
import type { StoredPaymentReference } from "#db/payment-reference-store.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { settings } from "#db/settings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Attendee, Listing, PaymentProviderType } from "#types";

/** Reproduce the raw owner-encrypted value and raw blind index old rows used. */
export const historicalPaymentReferenceStorage = async (
  reference: string,
): Promise<StoredPaymentReference> => ({
  encrypted: await encryptWithOwnerKey(reference, settings.publicKey),
  index: await hmacHash(reference),
});

/** Seed one old finalized row without opening a legacy production writer. */
export const seedHistoricalProcessedPayment = async (
  sessionId: string,
  attendeeId: number,
  reference: string,
): Promise<void> => {
  await reserveSession(sessionId);
  const stored = await historicalPaymentReferenceStorage(reference);
  const result = await execute(
    `UPDATE processed_payments
        SET attendee_id = ?, payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ? AND attendee_id IS NULL`,
    [attendeeId, stored.encrypted, stored.index, sessionId],
  );
  assert(
    result.rowsAffected === 1,
    `Could not seed historical payment ${sessionId}`,
  );
};

/** An attendee a pre-index release booked, with its listing. */
export type BookedLegacyAttendee = {
  readonly attendee: Attendee;
  readonly listing: Listing;
};

/** Book one attendee the way an older release left it: a paid PII blob, a
 * raw-format payment row with no blind index beside it, and no provenance
 * pointer. The starting point for every rebuild test. */
export const bookLegacyPaidAttendee = async (
  sessionId: string,
  paymentId: string,
): Promise<BookedLegacyAttendee> => {
  const listing = await createTestListing();
  const attendee = bookedAttendee(
    await bookAttendee(listing, {
      email: `${sessionId}@example.com`,
      name: "Old Release",
      paymentId,
    }),
  );
  await seedHistoricalProcessedPayment(sessionId, attendee.id, paymentId);
  await execute(
    "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
    [sessionId],
  );
  await execute(
    "UPDATE attendees SET pii_payment_session_id = NULL WHERE id = ?",
    [attendee.id],
  );
  return { attendee, listing };
};

/** The provider the owner stated for each row that does not name one. */
export const statedForEveryRow = async (
  provider: PaymentProviderType,
): Promise<ReadonlyMap<string, PaymentProviderType>> => {
  const page = await legacyPaymentReferencePage(await getTestPrivateKey());
  return new Map(
    page
      .filter((row) => !row.alreadyTagged)
      .map((row) => [row.paymentSessionId, provider]),
  );
};

/** A rebuild run where the owner stated one provider for every row that
 * needed a choice. */
export const rebuildStatingProviderForEveryRow = async (
  provider: PaymentProviderType,
): Promise<RebuiltLegacyReferences> =>
  await rebuildLegacyPaymentReferences(
    await statedForEveryRow(provider),
    await getTestPrivateKey(),
  );

/** The attendee's provenance pointer, or null while it is unqualified. */
export const provenancePointerOf = async (
  attendeeId: number,
): Promise<string | null> => {
  const row = await queryOne<{ pii_payment_session_id: string | null }>(
    "SELECT pii_payment_session_id FROM attendees WHERE id = ?",
    [attendeeId],
  );
  return row?.pii_payment_session_id ?? null;
};
