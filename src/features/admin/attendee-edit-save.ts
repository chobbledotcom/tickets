/**
 * The one save of an existing attendee. The admin Edit tab and the admin API
 * update both run it, so a change to how an edit saves lands in one place.
 * The caller parses its input into an {@link AttendeeEdit}, and this applies
 * it: the contact block, the status, the booking lines and any extra writes in
 * one transaction, then the contact tokens, the answers and the activity line.
 */

import { logActivity } from "#db/activity-log.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
} from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { syncAttendeeContactTokens } from "#db/contact-tokens.ts";
import {
  type AttendeeAnswerSet,
  saveAttendeeAnswers,
} from "#db/questions/attendee-answers/save.ts";
import type { SqlStatement } from "#db/sql.ts";
import { attendeeTaxSaveWork } from "#routes/admin/attendee-tax.ts";
import type { AttendeeUpdateFailureReason } from "#shared/attendee-failures.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { TaxSavePlan } from "#shared/tax/save.ts";
import { isTaxAssessmentConflict } from "#shared/tax/store.ts";
import type { Attendee, ContactInfo } from "#types";

/** One attendee edit, fully parsed. */
export type AttendeeEdit = {
  /** The activity line to log once the save lands. */
  activity: string;
  /** The answers to store, or null to leave the stored answers alone. */
  answers: AttendeeAnswerSet | null;
  /** The attendee as stored before the edit. */
  attendee: Attendee;
  /** The contact fields the attendee holds after the edit. */
  contact: ContactInfo;
  /** The booking lines the attendee holds after the edit. */
  desired: DesiredListingLine[];
  /** The stored lines before the edit, by line key. */
  existingByKey: Map<string, ListingAttendeeRow>;
  /** Writes that commit with the edit, after its own writes. */
  extraWork: SqlStatement[];
  statusId: number | null;
  taxPlan: TaxSavePlan;
};

/** Why an edit was not saved. Nothing is written in any of these cases. */
export type AttendeeEditFailure = AttendeeUpdateFailureReason | "tax_changed";

export type AttendeeEditOutcome =
  | { ok: true }
  | { ok: false; reason: AttendeeEditFailure };

/** The stored PII facts after an edit. The Edit tab has no location inputs,
 *  so a pinned location survives only while the address it was pinned for stays
 *  the same. An edit that changes the address clears the stale pin. */
const piiAfterEdit = (attendee: Attendee, contact: ContactInfo) => {
  const addressUnchanged = contact.address === attendee.address;
  return {
    address: contact.address,
    email: contact.email,
    lat: addressUnchanged ? attendee.lat : "",
    lng: addressUnchanged ? attendee.lng : "",
    name: contact.name,
    payment_id: attendee.payment_id,
    phone: contact.phone,
    special_instructions: contact.special_instructions,
    ticket_token: attendee.ticket_token,
  };
};

/** Keeps the ticket token attached to whichever contact owns it now. It also
 *  runs when the first real line appears, which links placeholders that have
 *  just become bookings. */
const syncContactTokens = async (
  edit: AttendeeEdit,
  hasRealLine: boolean,
): Promise<void> => {
  const { attendee, contact, existingByKey } = edit;
  const hadRealLine = [...existingByKey.values()].some(
    (line) => line.quantity > 0,
  );
  const contactChanged =
    contact.email !== attendee.email || contact.phone !== attendee.phone;
  const gainedFirstRealLine = hasRealLine && !hadRealLine;
  if (!contactChanged && !gainedFirstRealLine) return;
  await syncAttendeeContactTokens({
    after: { email: contact.email, phone: contact.phone },
    before: { email: attendee.email, phone: attendee.phone },
    firstRealBooking: gainedFirstRealLine,
    hasBooking: hasRealLine,
    privateKey: await requireRequestPrivateKey(),
    source: "admin",
    ticketToken: attendee.ticket_token,
  });
};

/** Save one parsed edit. A booking edit can deliberately overbook, as the
 *  admin form does (a warning shows, the system does not block). */
export const saveAttendeeEdit = async (
  edit: AttendeeEdit,
): Promise<AttendeeEditOutcome> => {
  const { attendee, contact, desired, taxPlan } = edit;
  const hasRealLine = desired.some((line) => line.quantity > 0);
  const work = await attendeeTaxSaveWork(
    attendee.id,
    edit.statusId,
    hasRealLine,
    taxPlan,
  );
  const result = await attendeesApi
    .applyAttendeeAtomicEdit(
      attendee.id,
      piiAfterEdit(attendee, contact),
      desired,
      true,
      { ...work, after: [...work.after, ...edit.extraWork] },
    )
    .catch((error: unknown) => {
      if (isTaxAssessmentConflict(error)) return null;
      throw error;
    });
  if (result === null) return { ok: false, reason: "tax_changed" };
  if (!result.success) return { ok: false, reason: result.reason };

  await syncContactTokens(edit, hasRealLine);
  if (edit.answers !== null) {
    await saveAttendeeAnswers(new Map([[attendee.id, edit.answers]]));
  }
  await logActivity(edit.activity, desired[0]?.listingId, attendee.id);
  return { ok: true };
};
