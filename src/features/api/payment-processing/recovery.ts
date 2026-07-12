import { compact } from "#fp";
import {
  type CreatedEntry,
  pairEntriesByListing,
} from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import {
  type placeholderBookings,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  BookingIntent,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#shared/db/attendees/queries.ts";
import {
  queryBatchPrimary,
  queryOnePrimary,
  resultRows,
} from "#shared/db/client.ts";
import { contactHash, recordVisit } from "#shared/db/contact-preferences.ts";
import { recordBooking } from "#shared/db/contact-tokens.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

type RecoveredBookingRow = {
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

type UnexpectedCreateRecovery = {
  complete: (
    entries: CreatedEntry[],
    ticketTokens: string[],
  ) => Promise<PaymentResult>;
  error: unknown;
  intent: BookingIntent;
  placeholders: ReturnType<typeof placeholderBookings>;
  session: ValidatedSession["session"];
  ticketToken: string;
  validatedItems: ValidatedItem[];
};

/** Rebuild notification entries from primary plaintext booking rows plus the
 * signed contact intent. A public payment callback cannot decrypt owner PII, but
 * it already holds the exact contact fields that were encrypted into this row. */
const recoveredEntries = async (
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
  const rows = resultRows<RecoveredBookingRow>(result!);
  const attendees: CreatedEntry["attendee"][] = rows.map((row) => ({
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

/** Restore the contact history normally written after the booking batch returns.
 * A committed batch whose result was lost never reached that completion step. */
const recordRecoveredOrderActivity = async (
  intent: BookingIntent,
  ticketToken: string,
): Promise<void> => {
  const hashes = await Promise.all(
    compact([
      intent.email.trim() ? contactHash("email", intent.email) : null,
      intent.phone.trim() ? contactHash("sms", intent.phone) : null,
    ]),
  );
  await Promise.all(
    hashes.map(async (hash) => {
      await recordVisit(hash);
      await recordBooking(hash, "public", ticketToken);
    }),
  );
};

/** Recover an atomically finalized ticket after result handling throws. Refund
 * only when the primary reservation proves the booking never committed. */
export const recoverOrRefundUnexpectedCreate = async ({
  complete,
  error,
  intent,
  placeholders,
  session,
  ticketToken,
  validatedItems,
}: UnexpectedCreateRecovery): Promise<PaymentResult> => {
  const ticketTokenIndex = await computeTicketTokenIndex(ticketToken);
  const finalized = await queryOnePrimary<{
    attendee_id: number;
  }>(
    `SELECT processedPayment.attendee_id
     FROM processed_payments AS processedPayment
     JOIN attendees AS attendee ON attendee.id = processedPayment.attendee_id
     WHERE processedPayment.payment_session_id = ?
       AND attendee.ticket_token_index = ?`,
    [session.id, ticketTokenIndex],
  );
  if (finalized !== null) {
    const entries = await recoveredEntries(
      finalized.attendee_id,
      ticketToken,
      session,
      intent,
      validatedItems,
    );
    await recordRecoveredOrderActivity(intent, ticketToken);
    return complete(entries, [ticketToken]);
  }

  const unresolved = await queryOnePrimary<{ present: number }>(
    `SELECT 1 AS present FROM processed_payments
     WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [session.id],
  );
  if (unresolved === null) throw error;

  const committedAttendee = await queryOnePrimary<{ id: number }>(
    "SELECT id FROM attendees WHERE ticket_token_index = ?",
    [ticketTokenIndex],
  );
  if (committedAttendee !== null) {
    // Some, but not all, booking rows landed. Refunding would leave live tickets
    // beside returned money, while retrying after the reservation goes stale
    // would duplicate the rows that landed. Keep it terminal for reconciliation.
    return {
      detail: `Partial paid booking requires reconciliation: ${String(error)}`,
      error:
        "Part of your booking could not be completed. Please contact support.",
      success: false,
    };
  }

  return storeRefundedBooking(
    session,
    intent,
    placeholders,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${session.id}: ${String(error)}`,
    ),
  );
};
