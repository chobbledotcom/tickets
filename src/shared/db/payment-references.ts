/**
 * Provider payment references used by admin refunds.
 *
 * Stored references are owner-key encrypted: checkout/webhook code can write them
 * with the public key, and admin refund routes decrypt them only inside an
 * authenticated request.
 */

import { unique } from "#fp";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, inPlaceholders, queryAll } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";

export type RefundPaymentReferenceSource = {
  id: number;
  payment_id: string;
};

export type RefundPaymentReference = {
  readonly providerRefunded: boolean;
  readonly reference: string;
  readonly sessionIds: readonly string[];
};

type PaymentReferenceRow = {
  attendee_id: number;
  payment_reference: string;
  payment_session_id: string;
  provider_refunded_at: string;
};

export const encryptPaymentReference = async (
  reference: string,
): Promise<OwnerKeyEncrypted | ""> =>
  reference === "" ? "" : encryptWithOwnerKey(reference, settings.publicKey);

const decryptPaymentReference = (
  stored: string,
  privateKey: CryptoKey,
): Promise<string> | string => {
  if (stored.startsWith(HYBRID_PREFIX)) {
    return decryptWithOwnerKey(stored as OwnerKeyEncrypted, privateKey);
  }
  // Development builds of the in-flight migration wrote this column in the clear.
  // Keep those rows refundable while every new write stores owner-key ciphertext.
  return stored;
};

const paymentReferencesForIds = (attendeeIds: readonly number[]) =>
  attendeeIds.length === 0
    ? Promise.resolve([])
    : queryAll<PaymentReferenceRow>(
        `SELECT attendee_id, payment_session_id, payment_reference, provider_refunded_at
           FROM processed_payments
          WHERE attendee_id IN (${inPlaceholders(attendeeIds)})
            AND payment_reference != ''
          ORDER BY attendee_id, processed_at, payment_session_id`,
        [...attendeeIds],
      );

const legacyReference = (reference: string): RefundPaymentReference => ({
  providerRefunded: false,
  reference,
  sessionIds: [],
});

const addReference = (
  byReference: Map<string, { providerRefunded: boolean; sessionIds: string[] }>,
  row: PaymentReferenceRow,
  reference: string,
): void => {
  const existing = byReference.get(reference);
  if (existing) {
    existing.sessionIds.push(row.payment_session_id);
    existing.providerRefunded ||= row.provider_refunded_at !== "";
  } else {
    byReference.set(reference, {
      providerRefunded: row.provider_refunded_at !== "",
      sessionIds: [row.payment_session_id],
    });
  }
};

const asRefundReferences = (
  byReference: Map<string, { providerRefunded: boolean; sessionIds: string[] }>,
): RefundPaymentReference[] =>
  [...byReference].map(([reference, data]) => ({
    providerRefunded: data.providerRefunded,
    reference,
    sessionIds: data.sessionIds,
  }));

/**
 * Refundable provider references for each attendee. New processed_payments rows
 * are the source of truth; old single-charge bookings fall back to attendees'
 * legacy payment_id when no per-session reference was recorded.
 */
export const getRefundPaymentReferences = async (
  attendees: readonly RefundPaymentReferenceSource[],
  privateKey: CryptoKey,
): Promise<Map<number, RefundPaymentReference[]>> => {
  const byAttendee = new Map(
    attendees.map((attendee) => [
      attendee.id,
      new Map<string, { providerRefunded: boolean; sessionIds: string[] }>(),
    ]),
  );
  for (const row of await paymentReferencesForIds(
    attendees.map((attendee) => attendee.id),
  )) {
    const reference = await decryptPaymentReference(
      row.payment_reference,
      privateKey,
    );
    if (reference) {
      addReference(byAttendee.get(Number(row.attendee_id))!, row, reference);
    }
  }
  return new Map(
    attendees.map((attendee) => {
      const references = asRefundReferences(byAttendee.get(attendee.id)!);
      return [
        attendee.id,
        references.length === 0 && attendee.payment_id !== ""
          ? [legacyReference(attendee.payment_id)]
          : references,
      ];
    }),
  );
};

export const hasRefundPaymentReference = async (
  attendee: RefundPaymentReferenceSource,
  privateKey: CryptoKey,
): Promise<boolean> =>
  (await getRefundPaymentReferences([attendee], privateKey)).get(attendee.id)!
    .length > 0;

/**
 * Mark processed-payment rows whose provider refund has already happened. The
 * ledger is still the source of the attendee's full-refund status; this per-charge
 * marker lets a later retry finish the remaining charges without re-calling the
 * provider for the ones already returned.
 */
export const markPaymentReferencesProviderRefunded = async (
  references: readonly RefundPaymentReference[],
): Promise<void> => {
  const sessionIds = unique(
    references.flatMap((reference) => reference.sessionIds),
  );
  if (sessionIds.length === 0) return;
  await execute(
    `UPDATE processed_payments
        SET provider_refunded_at = COALESCE(NULLIF(provider_refunded_at, ''), ?)
      WHERE payment_session_id IN (${inPlaceholders(sessionIds)})`,
    [nowIso(), ...sessionIds],
  );
};
