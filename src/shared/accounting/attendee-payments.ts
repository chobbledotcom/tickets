/** What each attendee paid: the money that reached their account from the
 * outside world. A checkout, a renewal, a settled balance and a payment that
 * the owner recorded all arrive this way. A refund leaves the account, so it
 * does not reduce these figures. */

import { ATTENDEE, WORLD } from "#accounting/accounts.ts";
import { ledgerLegs, onSide } from "#accounting/projection-sql.ts";
import { readRows } from "#db/read.ts";
import { among, equal, literal, sum, valued } from "#db/select/expression.ts";
import { sql } from "#db/sql.ts";

/** How many payments reached one attendee, their total, and the time of the
 * newest. An attendee with no payment has a count of zero and no time. */
export type PaymentSummary = {
  count: number;
  lastPaidAt: string | null;
  total: number;
};

const NO_PAYMENTS: PaymentSummary = { count: 0, lastPaidAt: null, total: 0 };

/** The payment summary of each attendee in `attendeeIds`, keyed by id. */
export const paymentSummaries = async (
  attendeeIds: readonly number[],
): Promise<Map<number, PaymentSummary>> => {
  const fromWorld = onSide("source", WORLD.type, WORLD.id);
  const rows = await readRows(
    ledgerLegs()
      .where((leg) => [
        fromWorld(leg),
        equal(leg.destType, literal(ATTENDEE)),
        among(leg.destId, attendeeIds.map(String)),
      ])
      .groupBy((leg) => [leg.destId])
      .select((leg) => ({
        attendee_id: leg.destId,
        count: valued<number>(sql`COUNT(*)`),
        last_paid_at: valued<string>(sql`MAX(${leg.occurredAt})`),
        total: sum(leg.amount),
      })),
  );
  const paid = new Map(
    rows.map((row): [number, PaymentSummary] => [
      Number(row.attendee_id),
      {
        count: Number(row.count),
        lastPaidAt: row.last_paid_at,
        total: Number(row.total),
      },
    ]),
  );
  return new Map(attendeeIds.map((id) => [id, paid.get(id) ?? NO_PAYMENTS]));
};
