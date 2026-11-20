/**
 * PUT /api/admin/attendees/:attendeeId — update a booking through the admin
 * JSON API.
 *
 * The update saves through the same code as the admin Edit tab
 * ({@link saveAttendeeEdit}), so a line change moves no money and the tax
 * rules are the form's. The body can change the contact fields, the status,
 * the booking lines, and the buyer's answers. It can also name the payments
 * received and the adjustments, as complete lists in the create's shape. A
 * receipt already stored as the same money adds nothing, so a repeated update
 * is a no-op. A receipt already stored as different money is refused. The
 * update never emails the buyer.
 */

import { insertIfNewStatements } from "#accounting/rows.ts";
import { loadExistingLines } from "#db/attendees/atomic-update.ts";
import { withDecryptedAttendee } from "#routes/admin/attendees-route-helpers.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { nowIso } from "#shared/now.ts";
import { newReceiptLegs } from "#shared/receipt-replay.ts";
import { requireValue } from "#shared/required-value.ts";
import { answerParsed, apiEntityGate } from "#shared/rest/crud-parsers.ts";
import { buildTaxSavePlan } from "#shared/tax/save.ts";
import { toAnswerSet, toApiAttendee } from "./api-attendees.ts";
import {
  type AttendeeToUpdate,
  type ParsedApiUpdate,
  parseUpdateBody,
} from "./api-attendees-update-parse.ts";
import {
  type AttendeeEditFailure,
  saveAttendeeEdit,
} from "./attendee-edit-save.ts";

/** What a caller reads when an update is not saved. */
const REFUSALS: Record<AttendeeEditFailure, string> = {
  capacity_exceeded: "Two lines book the same slot",
  no_lines: "Add at least one booking line",
  subscription_live:
    "A line with a running subscription cannot be removed. Cancel the subscription first.",
  tax_changed:
    "The tax on this booking has changed. Confirm the new tax on the attendee page, then send the update again.",
};

/** The attendee with its decrypted contact fields and its stored lines, or
 *  null when no attendee has the id. */
const loadAttendeeToUpdate: (
  attendeeId: number,
) => Promise<AttendeeToUpdate | null> = withDecryptedAttendee(
  async (attendee) => ({
    attendee,
    existing: await loadExistingLines(attendee.id),
  }),
);

/** Save a validated update and answer with the stored attendee. */
const updateFromParsed = async (
  { attendee, existing }: AttendeeToUpdate,
  parsed: ParsedApiUpdate,
): Promise<Response> => {
  const receipts = await newReceiptLegs(attendee.id, {
    adjustments: parsed.adjustments,
    payments: parsed.payments,
  });
  if (!receipts.ok) return apiErrorResponse(receipts.error);
  // A tax change needs the operator to confirm it, as the Edit tab asks. The
  // API has no preview to confirm, so it refuses the update.
  const taxPlan = await buildTaxSavePlan(attendee.id);
  if (taxPlan.preview.changed) return apiErrorResponse(REFUSALS.tax_changed);
  const outcome = await saveAttendeeEdit({
    activity: `Attendee '${parsed.contact.name}' updated via API`,
    answers: parsed.answers === null ? null : toAnswerSet(parsed.answers),
    attendee,
    contact: parsed.contact,
    desired: parsed.desired,
    existingByKey: new Map(existing.map((line) => [line.key, line.booking])),
    extraWork: insertIfNewStatements(receipts.value, nowIso()),
    statusId: parsed.statusId,
    taxPlan,
  });
  if (!outcome.ok) return apiErrorResponse(REFUSALS[outcome.reason]);
  const stored = requireValue(
    await loadAttendeeToUpdate(attendee.id),
    "Attendee vanished after its update",
  );
  return jsonResponse({ attendee: toApiAttendee(stored.attendee) });
};

const attendeeGate = apiEntityGate(loadAttendeeToUpdate, "Attendee", ADMIN_API);

/** Handle PUT /api/admin/attendees/:attendeeId. Staff-only, like the create. */
export const handleUpdateAttendee: RouteHandlerFn = (request, { attendeeId }) =>
  attendeeGate(request, attendeeId as number, (loaded, body) =>
    answerParsed(parseUpdateBody(body, loaded), (parsed) =>
      updateFromParsed(loaded, parsed),
    ),
  );
