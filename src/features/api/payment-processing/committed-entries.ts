/* jscpd:ignore-start -- imports */
import type { BlindIndex } from "#crypto/sealed.ts";
import { contactFields } from "#db/attendees/pii.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#db/attendees/select.ts";
import { queryAllPrimary } from "#db/client.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import {
  type CreatedEntry,
  listingsById,
} from "#routes/api/payment-processing/create.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

type CommittedBookingRow = {
  created: string;
  date: string | null;
  end_date: string | null;
  kind: string;
  listing_id: number;
  package_group_id: number;
  price_paid: number;
  quantity: number;
  remaining_balance: number;
  status_id: number | null;
  ticket_token_index: BlindIndex;
};

/** The booking whose committed lines the completion rebuilds. */
export type CommittedEntriesContext = {
  attendeeId: number;
  ticketToken: string;
  session: ValidatedSession["session"];
  intent: BookingIntent;
};

/** Rebuild completion entries from the committed primary rows and signed
 * contact data. The callback already holds the exact PII encrypted into the
 * attendee. The ticket token is the caller's: the rows hold only its blind
 * index. `listings` are the caller's loaded listing candidates, in place of
 * the fresh path's validated items. A committed line whose listing is gone
 * since the booking drops loudly: no notification can name a deleted
 * listing, and the live lines still notify. */
export const committedEntries = async (
  context: CommittedEntriesContext,
  listings: readonly { listing: ListingWithCount }[],
): Promise<CreatedEntry[]> => {
  const { attendeeId, ticketToken, session, intent } = context;
  const rows = await queryAllPrimary<CommittedBookingRow>({
    args: [attendeeId],
    sql: `SELECT attendee.created,
                   SUBSTR(listingAttendee.start_at, 1, 10) AS date,
                   SUBSTR(listingAttendee.end_at, 1, 10) AS end_date,
                   attendee.kind,
                   listingAttendee.listing_id,
                   listingAttendee.package_group_id,
                   ${pricePaidFromLedger(
                     "listingAttendee.attendee_id",
                     "listingAttendee.listing_id",
                     "listingAttendee.ledger_event_group",
                     "listingAttendee.id",
                   )},
                   listingAttendee.quantity,
                   ${remainingBalanceFromLedger("attendee.id")},
                   attendee.status_id,
                   attendee.ticket_token_index
            FROM attendees AS attendee
            JOIN listing_attendees AS listingAttendee
              ON listingAttendee.attendee_id = attendee.id
            WHERE attendee.id = ?
            ORDER BY listingAttendee.id`,
  });
  const listingById = listingsById(listings);
  return rows.flatMap((row): CreatedEntry[] => {
    const listing = listingById.get(row.listing_id);
    if (listing === undefined) {
      logError({
        code: ErrorCode.DATA_INVALID,
        detail: `Booking line's listing is gone (attendee ${attendeeId}, listing ${row.listing_id}); its notification omits the line`,
      });
      return [];
    }
    return [
      {
        attendee: {
          ...contactFields(intent),
          attachment_downloads: 0,
          checked_in: 0,
          created: row.created,
          date: row.date,
          end_date: row.end_date,
          id: attendeeId,
          kind: row.kind,
          lat: "",
          listing_id: row.listing_id,
          lng: "",
          package_group_id: row.package_group_id,
          payment_id: session.paymentReference,
          pii_blob: "",
          price_paid: String(row.price_paid),
          quantity: row.quantity,
          refunded: false,
          remaining_balance: row.remaining_balance,
          split_logistics_agents: false,
          status_id: row.status_id,
          ticket_token: ticketToken,
          ticket_token_index: row.ticket_token_index,
        },
        listing,
      },
    ];
  });
};

/** Rebuild the completion entries for the attendee's booked lines, and keep
 * the lines whose listing still exists. A gone listing cannot render, and
 * its line drops where the caller can log it. */
export const committedLiveEntries = async (
  listingIds: readonly number[],
  context: CommittedEntriesContext,
): Promise<CreatedEntry[]> => {
  const listings = await getListingsWithCountsByIds([...listingIds]);
  const live = listings.flatMap((listing) =>
    listing === null ? [] : [{ listing }],
  );
  return committedEntries(context, live);
};
