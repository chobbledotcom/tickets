/** Store the cash round-trip for a booking that could not be honoured. */

import {
  asOrderLegs,
  mapBooking,
  mapRefund,
} from "#shared/accounting/mappers.ts";
import { postTransferGroups } from "#shared/accounting/store.ts";
import { logRefundLedgerError } from "./log.ts";

type PlaceholderRefundFacts = {
  readonly attendeeId: number;
  readonly listingId: number;
  readonly amount: number;
  readonly occurredAt: string;
  readonly eventId: string;
};

const postWithoutThrowing = async (
  label: string,
  attendeeId: number,
  post: () => Promise<boolean>,
): Promise<{ posted: boolean }> => {
  try {
    return { posted: await post() };
  } catch (error) {
    logRefundLedgerError(
      `${label} failed for attendee ${attendeeId}: ${error}`,
    );
    return { posted: false };
  }
};

/**
 * Record the provider payment for a quantity-zero placeholder and, when it
 * completed, its cash refund. The two groups land atomically and contain no
 * sale: the booking was never honoured. A failed ledger write is logged and
 * reported without hiding or retrying the provider result.
 */
export const recordPlaceholderRefund = (
  facts: PlaceholderRefundFacts,
  memo: string,
  refunded: boolean,
): Promise<{ posted: boolean }> =>
  postWithoutThrowing(
    "placeholder refund ledger post",
    facts.attendeeId,
    async () => {
      const payment = await mapBooking({
        amountPaid: facts.amount,
        attendeeId: facts.attendeeId,
        bookingFee: 0,
        eventId: facts.eventId,
        lines: [{ gross: 0, listingId: facts.listingId }],
        modifiers: [],
        occurredAt: facts.occurredAt,
      });
      const groups = refunded
        ? [
            payment,
            await mapRefund({
              memo,
              occurredAt: facts.occurredAt,
              orderLegs: asOrderLegs(payment, facts.occurredAt),
            }),
          ]
        : [payment];
      await postTransferGroups(groups);
      return true;
    },
  );
