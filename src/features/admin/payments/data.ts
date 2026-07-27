import { unique } from "#fp";
import { getAttendeeNamesByIds } from "#shared/db/attendees/queries.ts";
import { queryAll } from "#shared/db/client.ts";
import { listingNames } from "#shared/db/listings/records.ts";
import {
  configuredPaymentAccounts,
  type PaymentAccount,
} from "#shared/payment-runtime/account.ts";
import {
  getPaymentOperatorCase,
  hasActivePaymentDecision,
  type PaymentOperatorCase,
} from "#shared/payment-runtime/operator-context.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

export type PaymentCaseLink = { id: number; name: string };

export interface PaymentCasePageData {
  accounts: PaymentAccount[];
  attendee: PaymentCaseLink | null;
  context: PaymentOperatorCase;
  listings: PaymentCaseLink[];
}

const attendeeIdFor = (context: PaymentOperatorCase): number | null =>
  context.payment.value.attendeeId;

const listingIdsFor = async (
  context: PaymentOperatorCase,
  attendeeId: number | null,
): Promise<number[]> => {
  if (context.payment.origin === "current") {
    return unique(
      context.payment.value.bookingIntent.items.map((item) => item.e),
    );
  }
  if (attendeeId === null) return [];
  const rows = await queryAll<{ listing_id: number }>(
    `SELECT DISTINCT listing_id FROM listing_attendees
      WHERE attendee_id = ? AND quantity > 0 ORDER BY listing_id`,
    [attendeeId],
  );
  return rows.map((row) => Number(row.listing_id));
};

export const loadPaymentCasePage = async (
  caseId: number,
): Promise<PaymentCasePageData | null> => {
  const context = await getPaymentOperatorCase(caseId);
  if (context === null) return null;
  const attendeeId = attendeeIdFor(context);
  const listingIds = await listingIdsFor(context, attendeeId);
  const [attendeeNames, names] = await Promise.all([
    attendeeId === null
      ? Promise.resolve(new Map<number, string>())
      : getAttendeeNamesByIds([attendeeId], await requireRequestPrivateKey()),
    listingNames.byIds(listingIds),
  ]);
  const accounts =
    context.payment.origin === "legacy" && !hasActivePaymentDecision(context)
      ? await configuredPaymentAccounts()
      : [];
  const attendeeName =
    attendeeId === null ? undefined : attendeeNames.get(attendeeId);
  return {
    accounts,
    attendee:
      attendeeId === null || attendeeName === undefined
        ? null
        : { id: attendeeId, name: attendeeName },
    context,
    listings: listingIds.flatMap((id) => {
      const name = names.get(id);
      return name === undefined ? [] : [{ id, name }];
    }),
  };
};
