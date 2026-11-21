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
import { balanceEventGroup } from "#db/attendees/balance.ts";
import { rewriteCheckoutBundle } from "#db/checkout-bundles.ts";
import { queryOne } from "#db/client.ts";
import { sql, sqlList } from "#db/sql.ts";
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

/** Whether a session is already settled: its payment row holds a booking or
 * a final outcome, or the ledger holds its money. The ledger outlives the
 * payment row, so a late replay still reads as settled. */
export const isSessionSettled = async (sessionId: string): Promise<boolean> => {
  const eventGroups = await Promise.all([
    bookingEventGroup(sessionId),
    balanceEventGroup(sessionId),
  ]);
  const row = await queryOne<{ settled: number }>(
    sql`SELECT (
        EXISTS(SELECT 1 FROM processed_payments AS payment
                WHERE payment.payment_session_id = ${sessionId}
                  AND (payment.attendee_id IS NOT NULL OR payment.failure_data != ''))
        OR EXISTS(SELECT 1 FROM transfers AS transfer
                   WHERE transfer.event_group IN (${sqlList(eventGroups)}))
      ) AS settled`,
  );
  return (
    requireValue(row, "A settled-session read gives one row").settled === 1
  );
};
