import { logActivity } from "#db/activity-log.ts";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { hasPaidLine } from "#db/attendees/queries.ts";
import { hasAssignedBuiltSite } from "#db/built-sites/claims.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#db/logistics.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import type { AttendeeAnswerSet } from "#db/questions/attendee-answers/save.ts";
import { t } from "#i18n";
import { saveAttendeeEdit } from "#routes/admin/attendee-edit-save.ts";
import {
  ATTENDEE_FORM_ID,
  type ParsedAttendeeForm,
  receiptsOf,
  toCreateInput,
  toDesiredLines,
  toLedgerOrder,
} from "#routes/admin/attendee-form-model.ts";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import { attendeeTaxSavedMessage } from "#routes/admin/attendee-tax.ts";
import {
  adminLineSend,
  anyNoQuantityLineMatches,
  emailPendingForAdminLines,
} from "#routes/admin/attendees-route-helpers.ts";
import { redirect } from "#routes/response.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import {
  apiCreateLedgerPoster,
  remainingBalanceOf,
} from "#shared/checkout-complete.ts";
import type { TaxSavePlan } from "#shared/tax/save.ts";
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
  // does not block). The poster records the sale legs at the lines' prices
  // plus the payment and adjustment legs in the same create transaction. The
  // input carries the projected net as remainingBalance, so the attendee owes
  // the tax-inclusive total minus what was paid or written off.
  const receipts = receiptsOf(parsed);
  const order = toLedgerOrder(parsed, receipts.adjustments);
  const createResult = await attendeesApi.createAttendeeAtomic(
    {
      ...input,
      allowOverbook: true,
      emailPending: emailPendingForAdminLines(parsed.lines.map(adminLineSend)),
      remainingBalance: remainingBalanceOf(order, receipts),
      source: "admin",
    },
    apiCreateLedgerPoster(order, receipts),
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
  subscription_live: "error.subscription_live",
  tax_changed: "attendee_form.tax_changed",
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

  const desired = toDesiredLines(parsed);
  const outcome = await saveAttendeeEdit({
    activity: `Attendee '${parsed.name}' updated`,
    answers: questions.length > 0 ? answers : null,
    attendee,
    contact: parsed,
    desired,
    existingByKey,
    extraWork: [],
    statusId: parsed.statusId,
    taxPlan,
  });
  if (!outcome.ok) {
    return { ok: false, saveError: t(EDIT_SAVE_ERRORS[outcome.reason]) };
  }
  await applyLogisticsPlan(attendeeId, logisticsPlan);
  return {
    ok: true,
    response: savedRedirect(
      attendeeId,
      parsed.returnUrl,
      attendeeTaxSavedMessage(parsed.name, {
        ...taxPlan.preview,
        afterBalance: outcome.hasRealLine ? taxPlan.preview.afterBalance : 0,
      }),
    ),
  };
};
