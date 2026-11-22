/**
 * A sealed order once its session is settled: booked, or ended with a final
 * handled outcome.
 *
 * The order holds the buyer's personal details, so the settle step replaces
 * it with a receipt. The receipt keeps only what a replay or the buyer's
 * return page reads: the lines, the package picks, the thank-you link, and
 * the balance target. The prune deletes the receipt later. After that, the
 * stored payment row or the ledger shows that the session is settled.
 */

import { bookingEventGroup } from "#accounting/mappers.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { balanceEventGroup } from "#db/attendees/balance.ts";
import { rewriteCheckoutBundle } from "#db/checkout-bundles.ts";
import { queryOne } from "#db/client.ts";
import { parseSessionFailure } from "#db/processed-payments.ts";
import { sql, sqlList } from "#db/sql.ts";
import type { StoredPaymentFailure } from "#payment/row-state.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { buildMetadata } from "#shared/payment-helpers.ts";
import { requireValue } from "#shared/required-value.ts";

/** Replace a settled session's sealed order with its receipt. A checkout that
 * carries its order in its own fields has nothing sealed to replace. */
export const keepOrderReceipt = async ({
  intent,
  session,
}: ValidatedSession): Promise<void> => {
  if (session.metadata.bundle === "") return;
  await rewriteCheckoutBundle(
    session.metadata.bundle,
    buildMetadata({
      allocations: intent.allocations,
      balanceAttendeeId: intent.balanceAttendeeId,
      date: null,
      email: "",
      items: intent.items,
      name: "",
      thankYouUrl: intent.thankYouUrl,
    }),
  );
};

/** Where a session stands when its order can no longer be read. The webhook
 * and the return page answer from this. A new standing is then a compile
 * error at every surface.
 * - booked: the payment row holds the booking.
 * - handled: the payment row holds a final outcome, such as a refund.
 * - recorded: the payment row is gone, but the ledger holds the money, so the
 *   outcome is known only to be final.
 * - open: none of these. The order is lost. */
export type SessionStanding =
  | { kind: "booked" }
  | { kind: "handled"; failure: StoredPaymentFailure }
  | { kind: "recorded" }
  | { kind: "open" };

/** A standing whose outcome is final. */
export type SettledStanding = Exclude<SessionStanding, { kind: "open" }>;

/** Read where a session stands, from its payment row and its ledger groups.
 * The ledger outlives the payment row, so a late replay still reads as
 * settled. */
export const sessionStanding = async (
  sessionId: string,
): Promise<SessionStanding> => {
  const eventGroups = await Promise.all([
    bookingEventGroup(sessionId),
    balanceEventGroup(sessionId),
  ]);
  const read = await queryOne<{
    attendee_id: number | null;
    failure_data: EnvKeyEncrypted | "" | null;
    recorded: number;
  }>(
    sql`SELECT
        (SELECT payment.attendee_id FROM processed_payments AS payment
          WHERE payment.payment_session_id = ${sessionId}) AS attendee_id,
        (SELECT payment.failure_data FROM processed_payments AS payment
          WHERE payment.payment_session_id = ${sessionId}) AS failure_data,
        EXISTS(SELECT 1 FROM transfers AS transfer
                WHERE transfer.event_group IN (${sqlList(eventGroups)})) AS recorded`,
  );
  const row = requireValue(read, "A session-standing read gives one row");
  if (row.attendee_id !== null) return { kind: "booked" };
  const failure = await parseSessionFailure(row.failure_data ?? "");
  if (failure !== null) return { failure, kind: "handled" };
  return row.recorded === 1 ? { kind: "recorded" } : { kind: "open" };
};
