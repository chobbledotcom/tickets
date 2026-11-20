/** Body parsing for PUT /api/admin/attendees/:attendeeId. Every field is
 * optional, and a field the body leaves out keeps its stored value. `payments`
 * and `adjustments` are the complete lists, in the shape the create takes.
 * `ticketToken` and `created` name the booking, so an update refuses both.
 * Pure data-in/data-out. The route owns the writes. */

import { attendeeStatuses } from "#db/attendee-statuses.ts";
import type { DesiredListingLine } from "#db/attendee-types.ts";
import type { ExistingLine } from "#db/attendees/atomic-update.ts";
import { unique } from "#fp";
import { parseAdjustments, parsePayments } from "#shared/booking-inputs.ts";
import type { CreateAdjustment } from "#shared/checkout-complete.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { Attendee, ContactInfo } from "#types";
import { keptLines, namedLines } from "./api-attendee-lines.ts";
import {
  type ApiAnswer,
  parseAnswers,
  parseCheckedLines,
  parseContact,
  readLinesArray,
  resolveStatusId,
} from "./api-attendees-parse.ts";

/** The attendee as an update reads it: the decrypted row and its lines. */
export type AttendeeToUpdate = {
  attendee: Attendee;
  existing: ExistingLine[];
};

/** The validated update body. */
export type ParsedApiUpdate = {
  adjustments: CreateAdjustment[];
  /** The answers to store, or null to leave the stored answers alone. */
  answers: ApiAnswer[] | null;
  contact: ContactInfo;
  desired: DesiredListingLine[];
  payments: number[];
  statusId: number | null;
};

/** The fields that name the booking. An update never changes them. */
const FIXED_FIELDS = ["created", "ticketToken"] as const;

/** The refusal for a fixed field the body carries, or null. */
const fixedFieldRefusal = (body: Record<string, unknown>): string | null => {
  const named = FIXED_FIELDS.find((field) => body[field] !== undefined);
  return named === undefined ? null : `${named} cannot be changed`;
};

/** The stored contact fields, as a create body names them. */
const storedContact = (attendee: Attendee): Record<string, unknown> => ({
  address: attendee.address,
  email: attendee.email,
  name: attendee.name,
  phone: attendee.phone,
  special_instructions: attendee.special_instructions,
});

/** The status the attendee holds after the update: the named one, or the
 *  stored one when the body names none. */
const parseStatusId = async (
  status: unknown,
  attendee: Attendee,
): Promise<Result<number | null>> => {
  if (status === undefined) return okResult(attendee.status_id);
  if (typeof status !== "string" || status === "") {
    return errorResult("status must be text");
  }
  return resolveStatusId(status, await attendeeStatuses.getAll());
};

/** The lines the attendee holds after the update, or the refusal. */
const parseDesiredLines = async (
  raw: unknown,
  existing: ExistingLine[],
): Promise<Result<DesiredListingLine[]>> => {
  if (raw === undefined) return okResult(keptLines(existing));
  const array = readLinesArray(raw);
  if (!array.ok) return array;
  const lines = await parseCheckedLines(array.value);
  return lines.ok ? okResult(namedLines(lines.value, existing)) : lines;
};

/** Parse and validate an update body. Nothing is written when any field is
 *  refused. */
export const parseUpdateBody = async (
  body: Record<string, unknown>,
  { attendee, existing }: AttendeeToUpdate,
): Promise<Result<ParsedApiUpdate>> => {
  const fixed = fixedFieldRefusal(body);
  if (fixed !== null) return errorResult(fixed);
  const contact = parseContact({ ...storedContact(attendee), ...body });
  if (!contact.ok) return contact;
  const statusId = await parseStatusId(body.status, attendee);
  if (!statusId.ok) return statusId;
  const payments = parsePayments(body.payments);
  if (!payments.ok) return payments;
  const adjustments = parseAdjustments(body.adjustments);
  if (!adjustments.ok) return adjustments;
  const desired = await parseDesiredLines(body.lines, existing);
  if (!desired.ok) return desired;
  const answers =
    body.answers === undefined
      ? okResult(null)
      : await parseAnswers(
          body.answers,
          unique(
            desired.value
              .filter((line) => line.quantity > 0)
              .map((line) => line.listingId),
          ),
        );
  if (!answers.ok) return answers;
  return okResult({
    adjustments: adjustments.value,
    answers: answers.value,
    contact: contact.value,
    desired: desired.value,
    payments: payments.value,
    statusId: statusId.value,
  });
};
