/**
 * POST /api/admin/attendees — create a booking through the admin JSON API.
 *
 * The create mirrors the manual-add form. It can overbook. A line can carry
 * an agreed per-unit `price`. The body can record `payments` already received.
 * It can carry named `adjustments` (one-off charges or writeoffs). The ledger
 * posts every leg at creation, so the projected balance is right from birth.
 * It never emails the buyer. The operator re-sends from the admin page. The
 * attendee rows, their listing lines, and the ledger legs commit together. A
 * caller-chosen `ticketToken` makes a retried create a no-op.
 */

/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import type {
  CreateAttendeeResult,
  ListingBooking,
} from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import type { PendingNotificationFlag } from "#db/attendees/notification-flags.ts";
import { decryptAttendeeFields } from "#db/attendees/pii.ts";
import { getAttendeeRawByToken } from "#db/attendees/queries.ts";
import { byId, sum, sumOf } from "#fp";
import { emailPendingForAdminLines } from "#routes/admin/attendees-route-helpers.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import {
  apiCreateLedgerPoster,
  type CreateAdjustment,
} from "#shared/checkout-complete.ts";
import {
  lineListPrice,
  listPriceOrder,
  type PricedOrder,
} from "#shared/checkout-pricing.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { queueManualAddWebhooks } from "#shared/webhook/delivery.ts";
import type { Attendee } from "#types";
/* jscpd:ignore-end */
import {
  type ApiLine,
  type ParsedApiCreate,
  parseCreateBody,
} from "./api-attendees-parse.ts";

/** One attendee booking row as the admin API answers with it: the decrypted
 * roster row minus the sealed PII blob and its blind index. Storage details go
 * the same way slug_index goes from listing responses. */
export type AdminApiAttendee = Omit<
  Attendee,
  "pii_blob" | "ticket_token_index"
>;

export const toApiAttendee = ({
  pii_blob: _,
  ticket_token_index: __,
  ...attendee
}: Attendee): AdminApiAttendee => attendee;

/** The owed-email flag a hand-added attendee starts with. It goes up (orange)
 * when a booked line's listing collects an email, because the API create
 * never sends the email itself. Every API line is a booked line. */
const emailPendingFor = (lines: ApiLine[]): PendingNotificationFlag =>
  emailPendingForAdminLines(
    lines.map((line) => ({
      fields: line.listing.fields,
      isBooked: true,
    })),
  );

/** The gross ledger order for an API-created booking. Every line is at the
 *  listing's list price unless the caller agreed a per-unit price for it. It
 *  carries no extras. The receipts (payments, adjustments) ride the poster. */
const toLedgerOrder = (lines: ApiLine[]): PricedOrder =>
  listPriceOrder(
    lines.map((line) => ({
      listing: line.listing,
      quantity: line.quantity,
      ...(line.price === undefined ? {} : { unitPrice: line.price }),
    })),
  );

/** The existing booking for a retried token, or null when the token is fresh.
 *  The unique ticket_token_index is the backstop for a race. Two concurrent
 *  creates can both see the token as fresh. */
const retriedAttendeeResponse = async (
  token: string,
): Promise<Response | null> => {
  const existing = await getAttendeeRawByToken(token);
  if (existing === null) return null;
  return jsonResponse({
    attendee: toApiAttendee(
      await decryptAttendeeFields(existing, await requireRequestPrivateKey()),
    ),
  });
};

/** Run the atomic create for a validated body and answer with the attendee.
 *  A concurrent create under the same caller token can win between the
 *  fresh-token check and the insert. The unique token index then refuses the
 *  loser, whose idempotent answer is the booking the winner stored. Any other
 *  failure is re-raised. */
const createFromParsed = async (parsed: ParsedApiCreate): Promise<Response> => {
  const { adjustments, created, lines, payments, statusId, ticketToken } =
    parsed;
  const bookings: ListingBooking[] = lines.map((line) => ({
    date: line.date,
    ...(line.date === null ? {} : { durationDays: line.durationDays }),
    listingId: line.listing.id,
    quantity: line.quantity,
  }));
  const order = toLedgerOrder(lines);
  const gross = sumOf(lineListPrice)(order.lines);
  const receipts = { adjustments, payments };
  // Admin manual add can deliberately overbook (a warning shows, the system
  // does not block). The poster records the sale legs at the lines' prices
  // plus the payment and adjustment legs in the same create transaction. The
  // input carries the projected net as remainingBalance, so the attendee owes
  // the lines and charges minus what was paid or written off.
  const remainingBalance =
    gross -
    sum(payments) +
    sumOf((adjustment: CreateAdjustment) => adjustment.amount)(adjustments);
  let result: CreateAttendeeResult;
  try {
    result = await attendeesApi.createAttendeeAtomic(
      {
        address: parsed.address,
        allowOverbook: true,
        bookings,
        email: parsed.email,
        emailPending: emailPendingFor(lines),
        name: parsed.name,
        phone: parsed.phone,
        remainingBalance,
        source: "admin",
        special_instructions: parsed.special_instructions,
        statusId,
        ...(ticketToken === undefined ? {} : { ticketToken }),
        ...(created === undefined ? {} : { created }),
      },
      apiCreateLedgerPoster(order, receipts),
    );
  } catch (error) {
    if (ticketToken !== undefined) {
      const retried = await retriedAttendeeResponse(ticketToken);
      if (retried !== null) return retried;
    }
    throw error;
  }
  if (!result.success) {
    return apiErrorResponse("The booking could not be created");
  }
  const attendee = result.attendees[0]!;
  const listingsById = byId(lines.map((line) => line.listing));
  // Notification behaviour matches a manual admin add: the buyer email waits
  // for the admin page's Re-send action, and the listings' webhooks fire.
  queueManualAddWebhooks(createdBookingEntries(result.attendees, listingsById));
  await logActivity(
    `Attendee '${parsed.name}' added via API`,
    lines[0]!.listing.id,
    attendee.id,
  );
  return jsonResponse({ attendee: toApiAttendee(attendee) }, 201);
};

/** Handle POST /api/admin/attendees. Staff-only, matching the dashboard's
 *  attendee create surface (areas-a-l.ts "attendees"). */
export const handleCreateAttendee: RouteHandlerFn = (request) =>
  withAuth(request, ADMIN_API, async (_session, body) => {
    const parsed = await parseCreateBody(body);
    if (!parsed.ok) return apiErrorResponse(parsed.error);
    // A caller-supplied token makes a retry a no-op: the booking already
    // exists under it, so nothing is written and the existing attendee is
    // returned.
    if (parsed.value.ticketToken !== undefined) {
      const retried = await retriedAttendeeResponse(parsed.value.ticketToken);
      if (retried !== null) return retried;
    }
    return createFromParsed(parsed.value);
  });
