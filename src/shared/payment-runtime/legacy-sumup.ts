import * as v from "valibot";
import { decryptWithKey } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { executeBatch } from "#shared/db/client.ts";
import {
  bindLegacyPaymentResource,
  getLegacyPaymentsByReferences,
  type LegacyPaymentReplay,
  recordLegacyMappingAmbiguity,
} from "#shared/db/payments/legacy-sessions.ts";
import {
  storeBookingIntent,
  storedSessionOutcomeValues,
  storeSessionProgress,
} from "#shared/db/payments/session-record.ts";
import { getPaymentSessionsPrimary } from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { ProviderMetadataSchema } from "#shared/payment-helpers.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import { signedBookingIntentFromMetadata } from "#shared/payment-runtime/metadata.ts";
import { signedPaymentFacts } from "#shared/payment-runtime/provider-read.ts";
import type { ProviderSessionResource } from "#shared/payment-state/resources.ts";
import { requireValue } from "#shared/required-value.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

const metadataJson = defineStoredJson(v.record(v.string(), v.string()));

export type LegacySumupPromotion =
  | { conflict: true }
  /** The old record stands, and this is the checkout it was filed under. */
  | { legacy: LegacyPaymentReplay; resource: ProviderSessionResource }
  | { payment: PaymentSession };

const currentSumupPayment = async (
  legacy: LegacyPaymentReplay,
  reference: string,
): Promise<LegacySumupPromotion> => {
  const checkout = legacy.runtime.sumupCheckout;
  if (checkout === null || checkout.sumupId === "") {
    throw new Error(`Legacy SumUp payment ${legacy.id} has no checkout id`);
  }
  const resource = PAYMENT_PROVIDER_RESOURCES.sumup.session(checkout.sumupId);
  if (
    legacy.runtime.processedPayment !== null ||
    legacy.state === "refunding"
  ) {
    return {
      legacy: await bindLegacyPaymentResource(legacy, resource),
      resource,
    };
  }
  const dataKey = await unwrapKeyWithToken(checkout.wrappedKey, reference);
  const metadata = metadataJson.read(
    await decryptWithKey(checkout.metadata, dataKey),
    `legacy SumUp metadata for ${legacy.id}`,
  );
  const signed = await signedBookingIntentFromMetadata(
    v.parse(ProviderMetadataSchema, metadata),
  );
  if (signed === null) {
    throw new Error(`Legacy SumUp payment ${legacy.id} has invalid metadata`);
  }
  const account = await resolvePaymentAccount("sumup");
  const facts = signedPaymentFacts(
    account,
    signed,
    settings.currency.toUpperCase(),
  );
  const [bookingIntent, progress] = await Promise.all([
    storeBookingIntent(facts.bookingIntent),
    storeSessionProgress({
      attendeeId: legacy.attendeeId,
      completion: null,
      completionState: "none",
      nextReconcileAt: null,
      result: null,
      resultState: "none",
      session: resource,
      state: "pending",
      ticketState: "none",
      ticketTokens: null,
    }),
  ]);
  await executeBatch([
    {
      args: [reference, legacy.id],
      sql: "UPDATE payment_charges SET payment_id = ? WHERE payment_id = ?",
    },
    {
      args: [reference, legacy.id],
      sql: "UPDATE payment_cases SET payment_id = ? WHERE payment_id = ?",
    },
    {
      args: [
        reference,
        facts.accountId,
        facts.mode,
        progress.sessionResource,
        progress.sessionReferenceIndex,
        facts.expected.amount,
        facts.expected.currency,
        bookingIntent,
        progress.state,
        ...storedSessionOutcomeValues(progress),
        legacy.id,
      ],
      sql: `UPDATE payment_sessions
        SET id = ?, origin = 'current', provider = 'sumup', account_id = ?,
            mode = ?, session_resource = ?, session_reference_index = ?,
            expected_amount = ?, expected_currency = ?, booking_intent = ?,
            state = ?, attendee_id = ?, result_state = ?, result = ?,
            ticket_state = ?, ticket_tokens = ?, completion_state = ?,
            completion = ?, revision = revision + 1
        WHERE id = ? AND origin = 'legacy'`,
    },
  ]);
  return {
    payment: requireValue(
      (await getPaymentSessionsPrimary([reference]))[0],
      `Legacy SumUp payment ${legacy.id} was not promoted`,
    ),
  };
};

/** Promote one encrypted pre-aggregate SumUp checkout without duplicating it. */
export const promoteLegacySumupPayment = async (
  reference: string,
): Promise<LegacySumupPromotion | null> => {
  const [current] = await getPaymentSessionsPrimary([reference]);
  if (current !== null && current !== undefined) return { payment: current };
  const referenceIndex = await hmacHash(reference);
  const candidates = (await getLegacyPaymentsByReferences([reference])).filter(
    (payment) =>
      payment.runtime.sumupCheckout?.referenceIndex === referenceIndex,
  );
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const checkoutId = candidates[0]?.runtime.sumupCheckout?.sumupId;
    if (checkoutId === undefined || checkoutId === "") {
      throw new Error("Ambiguous legacy SumUp payments have no checkout id");
    }
    const resource = PAYMENT_PROVIDER_RESOURCES.sumup.session(checkoutId);
    await recordLegacyMappingAmbiguity(candidates, resource);
    return { conflict: true };
  }
  return currentSumupPayment(candidates[0]!, reference);
};
