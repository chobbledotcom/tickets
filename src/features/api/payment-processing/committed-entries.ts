import type { BlindIndex } from "#crypto/sealed.ts";
import { contactFields } from "#db/attendees/pii.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#db/attendees/select.ts";
import { queryBatchPrimary, resultRows } from "#db/client.ts";
import {
  type CreatedEntry,
  pairEntriesByListing,
} from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";

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

/** Rebuild completion entries from committed primary rows and signed contact
 * data. The callback already holds the exact PII encrypted into the attendee. */
export const committedEntries = async (
  attendeeId: number,
  ticketToken: string,
  session: ValidatedSession["session"],
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
): Promise<CreatedEntry[]> => {
  const [result] = await queryBatchPrimary([
    {
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
    },
  ]);
  const attendees: CreatedEntry["attendee"][] = resultRows<CommittedBookingRow>(
    result!,
  ).map((row) => ({
    ...contactFields(intent),
    attachment_downloads: 0,
    checked_in: false,
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
  }));
  return pairEntriesByListing(attendees, validatedItems);
};
