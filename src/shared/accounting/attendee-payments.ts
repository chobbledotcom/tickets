/** What each attendee paid: the money that reached their account from the
 * outside world, less the money that a refund sent back. A checkout, a
 * renewal, a settled balance and a payment that the owner recorded all arrive
 * this way. */

import { ATTENDEE, WORLD } from "#accounting/accounts.ts";
import {
  every,
  type Leg,
  type LegTest,
  ledgerLegs,
  onSide,
  type Role,
  sideAmong,
  signedSum,
} from "#accounting/projection-sql.ts";
import { readRows } from "#db/read.ts";
import { literal, or, sum, valued, when } from "#db/select/expression.ts";
import { sql } from "#db/sql.ts";
import { epochMsToIso } from "#shared/validation/timestamp.ts";

/** How many payments reached one attendee, the total less refunds, and the
 * time of the newest payment. An attendee with no payment has a count of zero
 * and no time. */
export type PaymentSummary = {
  count: number;
  lastPaidAt: string | null;
  total: number;
};

const NO_PAYMENTS: PaymentSummary = { count: 0, lastPaidAt: null, total: 0 };

const world = (role: Role): LegTest => onSide(role, WORLD.type, WORLD.id);

/** The payment summary of each attendee in `attendeeIds`, keyed by id. */
export const paymentSummaries = async (
  attendeeIds: readonly number[],
): Promise<Map<number, PaymentSummary>> => {
  const ids = attendeeIds.map(String);
  const attendees = (role: Role) => sideAmong(role, literal(ATTENDEE), ids);
  const paid = every(world("source"), attendees("dest"));
  const refunded = every(attendees("source"), world("dest"));
  const attendeeOf = (leg: Leg) =>
    when<string>([[paid(leg), leg.destId]], leg.sourceId);
  const rows = await readRows(
    ledgerLegs()
      .where((leg) => or(paid(leg), refunded(leg)))
      .groupBy((leg) => [attendeeOf(leg)])
      .select((leg) => ({
        attendee_id: attendeeOf(leg),
        count: sum(when<number>([[paid(leg), literal(1)]], literal(0))),
        last_paid_at: valued<number | null>(
          sql`MAX(CASE WHEN ${paid(leg)} THEN ${leg.occurredAt} END)`,
        ),
        total: signedSum(paid, refunded)(leg),
      })),
  );
  const summaries = new Map(
    rows.map((row): [number, PaymentSummary] => [
      Number(row.attendee_id),
      {
        count: Number(row.count),
        lastPaidAt:
          row.last_paid_at === null
            ? null
            : epochMsToIso(Number(row.last_paid_at)),
        total: Number(row.total),
      },
    ]),
  );
  return new Map(
    attendeeIds.map((id) => [id, summaries.get(id) ?? NO_PAYMENTS]),
  );
};
