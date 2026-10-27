/**
 * POST /api/admin/attendees — create a booking through the admin JSON API.
 *
 * The create mirrors the manual-add form. It can overbook. It prices every
 * line at the listing's list price. It never emails the buyer. The operator
 * re-sends from the admin page, so the owed-email flag is set the same way.
 * The attendee rows, their listing lines, the contact activity, and the
 * ledger legs all commit in one transaction. A caller-chosen `ticketToken`
 * makes a retried create a no-op. The attendee under that token already
 * exists, so the create is skipped and the existing booking is returned.
 */

import * as v from "valibot";
/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import {
  type AttendeeStatus,
  attendeeStatuses,
} from "#db/attendee-statuses.ts";
import type {
  CreateAttendeeResult,
  ListingBooking,
} from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { hasDuplicateBookingSlot } from "#db/attendees/booking-slot.ts";
import type { PendingNotificationFlag } from "#db/attendees/notification-flags.ts";
import { decryptAttendeeFields } from "#db/attendees/pii.ts";
import { getAttendeeRawByToken } from "#db/attendees/queries.ts";
import { getListingsById } from "#db/listings/records.ts";
import { byId, sumOf } from "#fp";
import { emailPendingForAdminLines } from "#routes/admin/attendees-route-helpers.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import { manualAddLedgerPoster } from "#shared/checkout-complete.ts";
import {
  lineListPrice,
  listPriceOrder,
  type PricedOrder,
} from "#shared/checkout-pricing.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { isIsoDate } from "#shared/validation/date-string.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { queueManualAddWebhooks } from "#shared/webhook/delivery.ts";
import {
  validateAddress,
  validateEmail,
  validateName,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields/validators.ts";
import {
  type Attendee,
  type ContactInfo,
  clampDurationDays,
  type ListingWithCount,
  MAX_DURATION_DAYS,
} from "#types";
/* jscpd:ignore-end */

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

/** One validated booking line: its listing plus the quantities the caller
 * chose for it. */
type ApiLine = {
  date: string | null;
  durationDays: number;
  listing: ListingWithCount;
  quantity: number;
};

/** The validated create body: contact PII, the resolved status, the optional
 * retry token, and at least one booking line. */
type ParsedApiCreate = ContactInfo & {
  lines: ApiLine[];
  statusId: number;
  ticketToken: string | undefined;
};

const LINE_SCHEMA = v.object({
  date: v.optional(v.union([v.string(), v.null()])),
  durationDays: v.optional(
    v.pipe(integerAtLeast(1), v.maxValue(MAX_DURATION_DAYS)),
  ),
  listingId: integerAtLeast(1),
  quantity: integerAtLeast(1),
});

/** A text field, "" when absent. A non-text value is refused, never dropped. */
const optionalText = (raw: unknown, label: string): Result<string> =>
  raw === undefined
    ? okResult("")
    : typeof raw === "string"
      ? okResult(raw)
      : errorResult(`${label} must be text`);

/** One optional contact field: parse the text, then validate when non-empty.
 *  An empty value passes (the manual-add form accepts blank contact fields). */
const optionalContactField = (
  raw: unknown,
  label: string,
  validate: (value: string) => string | null,
): Result<string> => {
  const parsed = optionalText(raw, label);
  if (!parsed.ok) return parsed;
  if (parsed.value) {
    const error = validate(parsed.value);
    if (error) return errorResult(error);
  }
  return parsed;
};

/** The contact block's refusal, or the validated contact fields. */
const parseContact = (body: Record<string, unknown>): Result<ContactInfo> => {
  const name = body.name;
  if (typeof name !== "string" || name === "") {
    return errorResult("name is required");
  }
  const nameError = validateName(name);
  if (nameError) return errorResult(nameError);
  const email = optionalContactField(body.email, "email", validateEmail);
  if (!email.ok) return email;
  const phone = optionalContactField(body.phone, "phone", validatePhone);
  if (!phone.ok) return phone;
  const address = optionalContactField(
    body.address,
    "address",
    validateAddress,
  );
  if (!address.ok) return address;
  const instructions = optionalContactField(
    body.special_instructions,
    "special_instructions",
    validateSpecialInstructions,
  );
  if (!instructions.ok) return instructions;
  return okResult({
    address: address.value,
    email: email.value,
    name,
    phone: phone.value,
    special_instructions: instructions.value,
  });
};

/** The standard-line refusal, or null when the line carries none of the
 *  daily-only fields. */
const standardLineRefusal = (
  line: v.InferOutput<typeof LINE_SCHEMA>,
  at: string,
): string | null => {
  if (line.date !== undefined) {
    return `${at}.date only applies to daily listings`;
  }
  if (line.durationDays !== undefined) {
    return `${at}.durationDays only applies to daily listings`;
  }
  return null;
};

/** One line's refusal, or the validated line. */
const parseLine = (
  raw: unknown,
  listingsById: Map<number, ListingWithCount>,
  index: number,
): Result<ApiLine> => {
  const at = `lines[${index}]`;
  const parsed = v.safeParse(LINE_SCHEMA, raw);
  if (!parsed.success) {
    return errorResult(
      `${at} needs a positive listingId and quantity, and a whole durationDays from 1 to ${MAX_DURATION_DAYS}`,
    );
  }
  const line = parsed.output;
  const listing = listingsById.get(line.listingId);
  if (!listing) return errorResult(`${at} references an unknown listing`);
  if (line.quantity > listing.max_quantity) {
    return errorResult(`${at}.quantity is more than the listing allows`);
  }
  const isDaily = listing.listing_type === "daily";
  if (!isDaily) {
    const refusal = standardLineRefusal(line, at);
    if (refusal !== null) return errorResult(refusal);
  }
  const date = line.date ?? null;
  if (isDaily && (typeof date !== "string" || !isIsoDate(date))) {
    return errorResult(`${at}.date must be a booking day as YYYY-MM-DD`);
  }
  return okResult({
    date,
    durationDays: isDaily ? clampDurationDays(line.durationDays ?? 1) : 1,
    listing,
    quantity: line.quantity,
  });
};

/** The status a create body asks for. A named status resolves by name. When
 * the body names none, the attendee takes the public default, the same
 * coercion the manual-add form makes. A site with no public default is a
 * broken setup and fails loudly, never a silent status-less booking. */
const resolveStatusId = (
  name: string | undefined,
  statuses: AttendeeStatus[],
): Result<number> => {
  if (name !== undefined) {
    const status = statuses.find((candidate) => candidate.name === name);
    return status === undefined
      ? errorResult(`Unknown status '${name}'`)
      : okResult(status.id);
  }
  return okResult(
    requireValue(
      statuses.find((candidate) => candidate.is_public_default),
      "No public default status is configured",
    ).id,
  );
};

/** The status and retry token a body asks for, or the refusal. */
const parseStatusAndToken = async (
  body: Record<string, unknown>,
): Promise<Result<{ statusId: number; ticketToken: string | undefined }>> => {
  const status = body.status;
  if (status !== undefined && (typeof status !== "string" || status === "")) {
    return errorResult("status must be text");
  }
  const ticketToken = body.ticketToken;
  if (
    ticketToken !== undefined &&
    !v.is(v.pipe(v.string(), v.minLength(1)), ticketToken)
  ) {
    return errorResult("ticketToken must be non-empty text");
  }
  const statuses = await attendeeStatuses.getAll();
  const statusId = resolveStatusId(status as string | undefined, statuses);
  if (!statusId.ok) return statusId;
  return okResult({
    statusId: statusId.value,
    ticketToken: ticketToken as string | undefined,
  });
};

/** Parse and validate a create body. A body with no lines, an unknown listing,
 *  or an unknown status is refused before anything is written. */
const parseCreateBody = async (
  body: Record<string, unknown>,
): Promise<Result<ParsedApiCreate>> => {
  const contact = parseContact(body);
  if (!contact.ok) return contact;

  const linesRaw = body.lines;
  if (linesRaw === undefined) return errorResult("lines is required");
  if (!Array.isArray(linesRaw)) return errorResult("lines must be an array");
  if (linesRaw.length === 0) {
    return errorResult("Add at least one booking line");
  }
  const statusAndToken = await parseStatusAndToken(body);
  if (!statusAndToken.ok) return statusAndToken;

  const listingsById = await getListingsById();
  const lines: ApiLine[] = [];
  for (const [index, rawLine] of linesRaw.entries()) {
    const parsed = parseLine(rawLine, listingsById, index);
    if (!parsed.ok) return parsed;
    lines.push(parsed.value);
  }
  if (
    hasDuplicateBookingSlot(
      lines.map((line) => ({ date: line.date, listingId: line.listing.id })),
    )
  ) {
    return errorResult("Two lines book the same slot");
  }

  return okResult({
    ...contact.value,
    lines,
    statusId: statusAndToken.value.statusId,
    ticketToken: statusAndToken.value.ticketToken,
  });
};

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

/** The gross ledger order for an API-created booking: every line at the
 *  listing's list price, no extras, nothing collected. */
const toLedgerOrder = (lines: ApiLine[]): PricedOrder =>
  listPriceOrder(
    lines.map((line) => ({ listing: line.listing, quantity: line.quantity })),
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
  const { lines, statusId, ticketToken } = parsed;
  const bookings: ListingBooking[] = lines.map((line) => ({
    date: line.date,
    ...(line.date === null ? {} : { durationDays: line.durationDays }),
    listingId: line.listing.id,
    quantity: line.quantity,
  }));
  const order = toLedgerOrder(lines);
  // Admin manual add can deliberately overbook (a warning shows, the system
  // does not block). The ledger poster records the gross `sale` legs in the
  // SAME create transaction. The input carries that gross as remainingBalance,
  // so the attendee owes exactly what the lines cost.
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
        remainingBalance: sumOf(lineListPrice)(order.lines),
        source: "admin",
        special_instructions: parsed.special_instructions,
        statusId,
        ...(ticketToken === undefined ? {} : { ticketToken }),
      },
      manualAddLedgerPoster(order),
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
