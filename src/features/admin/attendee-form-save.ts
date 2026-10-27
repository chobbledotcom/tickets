import { logActivity } from "#db/activity-log.ts";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { hasPaidLine } from "#db/attendees/queries.ts";
import { hasAssignedBuiltSite } from "#db/built-sites/claims.ts";
import { syncAttendeeContactTokens } from "#db/contact-tokens.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#db/logistics.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import {
  type AttendeeAnswerSet,
  saveAttendeeAnswers,
} from "#db/questions/attendee-answers/save.ts";
import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  type ParsedAttendeeForm,
  toCreateInput,
  toDesiredLines,
  toLedgerOrder,
} from "#routes/admin/attendee-form-model.ts";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import {
  attendeeTaxSavedMessage,
  attendeeTaxSaveWork,
} from "#routes/admin/attendee-tax.ts";
import {
  adminLineSend,
  anyNoQuantityLineMatches,
  emailPendingForAdminLines,
} from "#routes/admin/attendees-route-helpers.ts";
import { redirect } from "#routes/response.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import { manualAddLedgerPoster } from "#shared/checkout-complete.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { TaxSavePlan } from "#shared/tax/save.ts";
import { isTaxAssessmentConflict } from "#shared/tax/store.ts";
import { queueManualAddWebhooks } from "#shared/webhook/delivery.ts";
import type { Attendee, ListingWithCount } from "#types";

/** Outcome of an atomic create/edit attempt. */
export type SaveOutcome =
  | { ok: true; response: Response }
  | { ok: false; saveError: string };

/** The Edit tab for an attendee, carrying the return_url through. */
const attendeeEditPath = (id: number, returnUrl: string): string => {
  const editPath = attendeePage.path(id, "edit");
  return returnUrl
    ? `${editPath}?return_url=${encodeURIComponent(returnUrl)}`
    : editPath;
};

/** Redirect back to the saved attendee's Edit tab, with the flash targeted
 * at (and scrolled to) the form. */
const savedRedirect = (
  id: number,
  returnUrl: string,
  message: string,
): Response =>
  redirect(attendeeEditPath(id, returnUrl), message, true, {
    formId: ATTENDEE_FORM_ID,
  });

/** The submitted logistics assignment plan, or null when logistics is off. */
type LogisticsPlan = {
  split: boolean;
  perListing: Map<number, LogisticsAssignment>;
} | null;

/** Persist the logistics assignment plan against a saved attendee. */
const applyLogisticsPlan = (
  attendeeId: number,
  plan: LogisticsPlan,
): Promise<void> =>
  plan
    ? setLogisticsAssignments(attendeeId, plan.split, plan.perListing)
    : Promise.resolve();

export const applyCreate = async (
  parsed: ParsedAttendeeForm,
  logisticsPlan: LogisticsPlan,
  listingsById: Map<number, ListingWithCount>,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { ok: false, saveError: t("attendee_form.error_no_lines") };
  }
  // Admin manual add can deliberately overbook (a warning shows, the system
  // does not block). The ledger poster records the gross `sale` legs in the
  // SAME create transaction. The input carries that gross as remainingBalance,
  // so the webhook reports the amount the attendee owes.
  const order = toLedgerOrder(parsed);
  const createResult = await attendeesApi.createAttendeeAtomic(
    {
      ...input,
      allowOverbook: true,
      emailPending: emailPendingForAdminLines(parsed.lines.map(adminLineSend)),
      remainingBalance: order.tax.total,
      source: "admin",
    },
    manualAddLedgerPoster(order),
  );
  if (!createResult.success) {
    return { ok: false, saveError: t("attendee_form.error_capacity") };
  }
  const { attendees } = createResult;
  const firstListingId = input.bookings[0]!.listingId;
  const newId = attendees[0]!.id;
  await applyLogisticsPlan(newId, logisticsPlan);
  // An online booking tells the listings' webhooks, and so does a manual add.
  // Webhooks only: the buyer email waits for the "Re-send notification"
  // action, which sends the webhooks again too. The activity line below
  // stays the only create line.
  queueManualAddWebhooks(createdBookingEntries(attendees, listingsById));
  await logActivity(
    `Attendee '${parsed.name}' added manually`,
    firstListingId,
    newId,
  );
  return {
    ok: true,
    response: savedRedirect(
      newId,
      parsed.returnUrl,
      t("attendee_form.saved_added", { value: parsed.name }),
    ),
  };
};

const EDIT_SAVE_ERRORS = {
  capacity_exceeded: "attendee_form.error_capacity",
  no_lines: "attendee_form.error_no_lines",
} as const;

export const applyEdit = async (
  attendeeId: number,
  parsed: ParsedAttendeeForm,
  attendee: Attendee,
  questions: QuestionWithAnswers[],
  answers: AttendeeAnswerSet,
  logisticsPlan: LogisticsPlan,
  existingByKey: Map<string, ListingAttendeeRow>,
  taxPlan: TaxSavePlan,
): Promise<SaveOutcome> => {
  // Block marking an assigned built-site line no-quantity (no release path here).
  if (
    await anyNoQuantityLineMatches(
      attendeeId,
      parsed.lines,
      hasAssignedBuiltSite,
    )
  ) {
    return {
      ok: false,
      saveError: t("attendee_form.error_built_site_no_qty"),
    };
  }
  // Block marking a paid line no-quantity, even when a stale form key hid the
  // existing booking from the per-line model guard.
  if (await anyNoQuantityLineMatches(attendeeId, parsed.lines, hasPaidLine)) {
    return { ok: false, saveError: t("attendee_form.error_paid_no_qty") };
  }

  // The Edit tab has no location inputs, so the Logistics pin survives only
  // while the address it was pinned for stays the same. An edit that changes
  // the address clears the now-stale pin (a fresh one is set on the
  // Logistics tab).
  const addressUnchanged = parsed.address === attendee.address;
  const pii = {
    address: parsed.address,
    email: parsed.email,
    lat: addressUnchanged ? attendee.lat : "",
    lng: addressUnchanged ? attendee.lng : "",
    name: parsed.name,
    payment_id: attendee.payment_id,
    phone: parsed.phone,
    special_instructions: parsed.special_instructions,
    ticket_token: attendee.ticket_token,
  };

  const desired = toDesiredLines(parsed);
  const hasRealLine = desired.some((line) => line.quantity > 0);
  // Admin manual edit can deliberately overbook (warned, not blocked).
  const editResult = await attendeesApi
    .applyAttendeeAtomicEdit(
      attendeeId,
      pii,
      desired,
      true,
      await attendeeTaxSaveWork(
        attendeeId,
        parsed.statusId,
        hasRealLine,
        taxPlan,
      ),
    )
    .catch((error: unknown) => {
      if (isTaxAssessmentConflict(error)) return null;
      throw error;
    });
  if (editResult === null) {
    return { ok: false, saveError: t("attendee_form.tax_changed") };
  }
  if (!editResult.success) {
    return { ok: false, saveError: t(EDIT_SAVE_ERRORS[editResult.reason]) };
  }

  const hadRealLine = [...existingByKey.values()].some(
    (line) => line.quantity > 0,
  );
  const contactChanged =
    parsed.email !== attendee.email || parsed.phone !== attendee.phone;
  const gainedFirstRealLine = hasRealLine && !hadRealLine;
  if (contactChanged || gainedFirstRealLine) {
    // Keep this attendee's ticket token attached to whichever contact owns it
    // now. Running when the first real line appears links placeholders that
    // have just become bookings.
    await syncAttendeeContactTokens({
      after: { email: parsed.email, phone: parsed.phone },
      before: { email: attendee.email, phone: attendee.phone },
      firstRealBooking: gainedFirstRealLine,
      hasBooking: hasRealLine,
      privateKey: await requireRequestPrivateKey(),
      source: "admin",
      ticketToken: attendee.ticket_token,
    });
  }

  await applyLogisticsPlan(attendeeId, logisticsPlan);

  if (questions.length > 0) {
    await saveAttendeeAnswers(new Map([[attendeeId, answers]]));
  }

  const firstListingId = desired[0]?.listingId;
  await logActivity(
    `Attendee '${parsed.name}' updated`,
    firstListingId,
    attendeeId,
  );
  return {
    ok: true,
    response: savedRedirect(
      attendeeId,
      parsed.returnUrl,
      attendeeTaxSavedMessage(parsed.name, {
        ...taxPlan.preview,
        afterBalance: hasRealLine ? taxPlan.preview.afterBalance : 0,
      }),
    ),
  };
};
