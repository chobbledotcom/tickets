import { CHECKOUT_STAGE_RETENTION_MS } from "#shared/checkout-stage-retry.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb, insert } from "#shared/db/client.ts";
import type {
  RefundCode,
  StoredCheckoutRefund,
} from "#shared/refund-reasons.ts";

export const testCheckoutRefund = (
  code: RefundCode = "unexpected_error",
): StoredCheckoutRefund => ({
  code,
  detail: "Test checkout refund",
});

/** Insert a dormant checkout stage for cleanup-path tests. */
export const insertCheckoutStage = async (
  attendeeId: number,
  paymentSessionId: string,
  options: {
    createdAt?: string;
    nextAttemptAt?: number;
    providerCheckoutId?: string;
    state?: "paid" | "pending" | "refunding";
  } = {},
): Promise<unknown> => {
  const createdAt = options.createdAt ?? "2026-07-15T12:00:00.000Z";
  return getDb().execute(
    insert("checkout_stages", {
      attempt_count: 0,
      attendee_id: attendeeId,
      created_at: createdAt,
      last_attempt_at: null,
      next_attempt_at:
        options.nextAttemptAt ??
        new Date(createdAt).getTime() + CHECKOUT_STAGE_RETENTION_MS,
      payment_session_id: paymentSessionId,
      provider: "stripe",
      provider_checkout_id: options.providerCheckoutId ?? paymentSessionId,
      state: options.state ?? "pending",
      ticket_tokens: await encrypt(`token-${paymentSessionId}`),
    }),
  );
};
