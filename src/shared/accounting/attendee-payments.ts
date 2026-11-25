/** What each attendee paid: the money that reached their account from the
 * outside world, less the money that a refund sent back. A checkout, a
 * renewal, a settled balance and a payment that the owner recorded all arrive
 * this way. */

import { ATTENDEE } from "#accounting/accounts.ts";
import { readMeasuresByAccount } from "#accounting/measure-reads.ts";
import {
  type AccountId,
  countOf,
  externalCashOf,
  largestOf,
  oneAccount,
  paidIn,
} from "#accounting/projection-sql.ts";
import { epochMsToIso } from "#shared/validation/timestamp.ts";

/** How many payments reached one attendee, the total less refunds, and the
 * time of the newest payment. An attendee with no payment has a count of zero
 * and no time. */
export type PaymentSummary = {
  count: number;
  lastPaidAt: string | null;
  total: number;
};

const paymentMeasures = (id: AccountId) => {
  const attendee = oneAccount(ATTENDEE, id);
  return {
    count: countOf(paidIn(attendee)),
    lastPaidAt: largestOf(paidIn(attendee), (leg) => leg.occurredAt),
    total: externalCashOf(attendee),
  };
};

/** The payment summary of each attendee in `attendeeIds`, keyed by id. */
export const paymentSummaries = async (
  attendeeIds: readonly number[],
): Promise<Map<number, PaymentSummary>> => {
  const read = await readMeasuresByAccount(attendeeIds, paymentMeasures);
  return new Map(
    [...read].map(([id, { count, lastPaidAt, total }]) => [
      id,
      {
        count,
        lastPaidAt: lastPaidAt === null ? null : epochMsToIso(lastPaidAt),
        total,
      },
    ]),
  );
};
