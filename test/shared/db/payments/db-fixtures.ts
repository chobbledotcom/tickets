import { getDb } from "#shared/db/client.ts";

export const insertLegacyPaymentCharge = async (
  paymentId = "legacy-payment",
): Promise<void> => {
  await getDb().execute(
    `INSERT INTO payment_charges
    (payment_id, origin, provider_reference, refund_state,
     provider_refunded_at, legacy_source, created_at, updated_at, observed_at)
    VALUES (?, 'legacy', 'hyb:1:legacy-reference', 'unknown',
      '2026-07-25T10:00:00.000Z', 'processed_payments', 1, 2, 3)`,
    [paymentId],
  );
};
