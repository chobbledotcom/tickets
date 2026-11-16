import { getDb } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { insertInto } from "#db/write.ts";

/** Insert a dormant checkout stage for cleanup-path tests. */
export const insertCheckoutStage = (
  attendeeId: number,
  paymentSessionId: string,
): Promise<unknown> =>
  getDb().execute(
    insertInto(tables.checkout_stages, {
      attendee_id: attendeeId,
      created_at: "2026-07-15T12:00:00.000Z",
      payment_session_id: paymentSessionId,
      provider: "stripe",
      state: "open",
      ticket_tokens: "[]",
    }),
  );
