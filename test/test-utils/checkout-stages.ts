import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb, insert } from "#shared/db/client.ts";

/** Insert a dormant checkout stage for cleanup-path tests. */
export const insertCheckoutStage = async (
  attendeeId: number,
  paymentSessionId: string,
  options: {
    createdAt?: string;
    providerCheckoutId?: string;
    state?: "pending" | "refunding";
  } = {},
): Promise<unknown> =>
  getDb().execute(
    insert("checkout_stages", {
      attendee_id: attendeeId,
      created_at: options.createdAt ?? "2026-07-15T12:00:00.000Z",
      payment_session_id: paymentSessionId,
      provider: "stripe",
      provider_checkout_id: options.providerCheckoutId ?? paymentSessionId,
      state: options.state ?? "pending",
      ticket_tokens: await encrypt(`token-${paymentSessionId}`),
    }),
  );
