/** Body parsing for POST /api/admin/attendees. It validates the create
 * request: contact PII, at least one booking line, the payments already
 * received, and the named one-off adjustments. Each line can carry an optional
 * agreed per-unit price. Pure data-in/data-out. The route owns the writes. */

import * as v from "valibot";
/* jscpd:ignore-start */
import {
  type AttendeeStatus,
  attendeeStatuses,
  publicDefaultStatusOf,
} from "#db/attendee-statuses.ts";
import { hasDuplicateBookingSlot } from "#db/attendees/booking-slot.ts";
import { getListingsById } from "#db/listings/records.ts";
import {
  parseAdjustments,
  parseLinePrice,
  parsePayments,
  quantityOverCap,
} from "#shared/booking-inputs.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import type { CreateAdjustment } from "#shared/checkout-complete.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isIsoDate } from "#shared/validation/date-string.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import {
  epochMsToIso,
  instantToEpochMs,
  isInstant,
} from "#shared/validation/timestamp.ts";
import {
  validateAddress,
  validateEmail,
  validateName,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields/validators.ts";
import {
  type ContactInfo,
  clampDurationDays,
  type ListingWithCount,
  MAX_DURATION_DAYS,
} from "#types";
/* jscpd:ignore-end */

/** One validated booking line: its listing, the quantities the caller chose,
 * and the optional per-unit price override (minor units) they agreed. */
export type ApiLine = {
  date: string | null;
  durationDays: number;
  listing: ListingWithCount;
  price: number | undefined;
  quantity: number;
};

/** The validated create body. It holds the contact PII, the resolved status,
 * the optional retry token, and at least one booking line. It also holds the
 * payments received now and the named one-off adjustments. */
export type ParsedApiCreate = ContactInfo & {
  adjustments: CreateAdjustment[];
  /** The business time the booking happened, when the caller stamps a
   * historical one. Absent means now at insert. */
  created: string | undefined;
  lines: ApiLine[];
  payments: number[];
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

/** The line's booking day, or the refusal. Date-less listings carry none. */
const resolveLineDate = (
  isDaily: boolean,
  line: v.InferOutput<typeof LINE_SCHEMA>,
  at: string,
): Result<string | null> => {
  const date = line.date ?? null;
  if (isDaily && (typeof date !== "string" || !isIsoDate(date))) {
    return errorResult(`${at}.date must be a booking day as YYYY-MM-DD`);
  }
  return okResult(date);
};

/** One line's refusal, or the validated line. */
const parseLine = (
  raw: unknown,
  listingsById: Map<number, ListingWithCount>,
  index: number,
): Result<ApiLine> => {
  const at = `lines[${index}]`;
  const price = parseLinePrice(
    (raw as Record<string, unknown> | null)?.price,
    at,
  );
  if (!price.ok) return price;
  const parsed = v.safeParse(LINE_SCHEMA, raw);
  if (!parsed.success) {
    return errorResult(
      `${at} needs a positive listingId and quantity, and a whole durationDays from 1 to ${MAX_DURATION_DAYS}`,
    );
  }
  const line = parsed.output;
  const listing = listingsById.get(line.listingId);
  if (!listing) return errorResult(`${at} references an unknown listing`);
  if (quantityOverCap(line.quantity, listing.max_quantity)) {
    return errorResult(`${at}.quantity is more than the listing allows`);
  }
  const isDaily = countsPerDate(listing.listing_type);
  if (!isDaily) {
    const refusal = standardLineRefusal(line, at);
    if (refusal !== null) return errorResult(refusal);
  }
  const date = resolveLineDate(isDaily, line, at);
  if (!date.ok) return date;
  return okResult({
    date: date.value,
    durationDays: isDaily ? clampDurationDays(line.durationDays ?? 1) : 1,
    listing,
    price: price.value,
    quantity: line.quantity,
  });
};

/** The business time the booking happened, when the caller stamps a
 *  historical one. An absent value keeps the create-time clock. A supplied
 *  instant is normalised to the canonical UTC millisecond form the clock
 *  writes, so every stored `created` sorts the same way in date-ordered
 *  lists. */
const parseCreated = (raw: unknown): Result<string | undefined> => {
  if (raw === undefined) return okResult(undefined);
  return typeof raw === "string" && isInstant(raw)
    ? okResult(epochMsToIso(instantToEpochMs(raw)))
    : errorResult("created must be a valid instant as 2026-09-01T09:00:00Z");
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
  return okResult(publicDefaultStatusOf(statuses).id);
};

/** One JSON body read: the parsed value, or the field refusal. */
type BodyRead<Parsed> = (
  body: Record<string, unknown>,
) => Promise<Result<Parsed>>;

/** The status and retry token a body asks for, or the refusal. */
const parseStatusAndToken: BodyRead<{
  statusId: number;
  ticketToken: string | undefined;
}> = async (body) => {
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
  // The token names the buyer's ticket page and sits inside the encrypted
  // PII blob. It shares the length cap every other create-body text field
  // carries, so it stays bounded.
  if (
    typeof ticketToken === "string" &&
    ticketToken.length > MAX_INPUT_LENGTH
  ) {
    return errorResult(
      `ticketToken must be ${MAX_INPUT_LENGTH} characters or fewer`,
    );
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
export const parseCreateBody: BodyRead<ParsedApiCreate> = async (body) => {
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
  const created = parseCreated(body.created);
  if (!created.ok) return created;
  const payments = parsePayments(body.payments);
  if (!payments.ok) return payments;
  const adjustments = parseAdjustments(body.adjustments);
  if (!adjustments.ok) return adjustments;

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
    adjustments: adjustments.value,
    created: created.value,
    lines,
    payments: payments.value,
    statusId: statusAndToken.value.statusId,
    ticketToken: statusAndToken.value.ticketToken,
  });
};
