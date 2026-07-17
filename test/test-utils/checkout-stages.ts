import { getDb, insert } from "#shared/db/client.ts";

/** Insert a dormant checkout stage for cleanup-path tests. */
export const insertCheckoutStage = (
  attendeeId: number,
  paymentSessionId: string,
): Promise<unknown> =>
  getDb().execute(
    insert("checkout_stages", {
      attendee_id: attendeeId,
      created_at: "2026-07-15T12:00:00.000Z",
      payment_session_id: paymentSessionId,
      provider: "stripe",
      state: "open",
      ticket_tokens: "[]",
    }),
  );
