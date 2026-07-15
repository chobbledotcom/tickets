/**
 * Routes for creating and saving attendees.
 *
 *   GET  /admin/attendees/new      — render the create form
 *   POST /admin/attendees/new      — handle create submission
 *   POST /admin/attendees/:id      — handle edit submission
 *
 * (GET /admin/attendees/:id and its tabs render through the attendee entity
 * page — attendee-page.ts.)
 *
 * The editor is a fixed table — one quantity box per bookable listing (plus any
 * inactive listing the attendee already booked) — and one shared date range, so
 * a submission is a single self-contained save with no add/remove-line round
 * trips. Create can be deep-linked from the calendar availability checker with
 * `?select_<id>=1&start_date=…` to pre-fill the chosen listings and date.
 *
 * Feedback: a successful save PRG-redirects to the Edit tab; a validation or
 * recoverable save failure re-renders the submitted form IN PLACE (through the
 * entity page for edits) so entered data and per-line errors are never lost —
 * deliberately not a stash-dependent bounce.
 */

/* jscpd:ignore-start */
import { byId } from "#fp";
import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  isNoQuantityLine,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  resolveStatusId,
  toCreateInput,
  toDesiredLines,
  toLedgerOrder,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import { parseLogisticsPlan } from "#routes/admin/attendee-logistics.ts";
import { attendeePage } from "#routes/admin/attendee-page.ts";
import {
  buildCreateForm,
  buildTemplateData,
  emptySelectedQuestionAnswers,
  getRenderListings,
  loadAttendeeForEdit,
  loadPackagePaths,
  loadQuestionsForExisting,
  packagesByListingIdFrom,
} from "#routes/admin/attendee-page-data.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { manualAddLedgerPoster } from "#shared/checkout-complete.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import {
  applyAttendeeAtomicEdit,
  createAttendeeAtomic,
} from "#shared/db/attendees/api.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  attendeeHoldsUnreturnedCash,
  hasPaidLine,
} from "#shared/db/attendees/queries.ts";
import { updateAttendeeStatus } from "#shared/db/attendees/update.ts";
import { hasAssignedBuiltSite } from "#shared/db/built-sites.ts";
import { hasPendingCheckout } from "#shared/db/checkout-stages.ts";
import { syncAttendeeContactTokens } from "#shared/db/contact-tokens.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import type {
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#shared/db/question-types.ts";
import {
  type AttendeeAnswerSet,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers/save.ts";
import { parseQuestionAnswers } from "#shared/db/questions/parsing.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  loadAfterDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import {
  AttendeeFormPanel,
  type AttendeeFormTemplateData,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";
/* jscpd:ignore-end */

// ---------------------------------------------------------------------------
// GET /admin/attendees/new
// ---------------------------------------------------------------------------

/** Handle GET /admin/attendees/new — render the create form, pre-filled from a
 * calendar deep link when present. */
export const handleAttendeeNewGet: TypedRouteHandler<
  "GET /admin/attendees/new"
> = (request) =>
  requireSessionOr(request, async (session) => {
    applyFlash(request);
    const renderListings = await getRenderListings([]);
    const params = new URL(request.url).searchParams;
    const parsed = buildCreateForm(
      renderListings,
      await loadPackagePaths(),
      selectedListingQuantities(params),
      selectedStartDate(params),
    );
    const data = await buildTemplateData("create", parsed, null, {
      returnUrl: getSearchParam(request, "return_url"),
    });
    return htmlResponse(attendeeFormPage(data, session));
  });

// ---------------------------------------------------------------------------
// POST handlers — shared submit logic
// ---------------------------------------------------------------------------

/** Everything the submit handler needs about an attendee being edited. */
type EditContext = SelectedQuestionAnswers & {
  attendee: Attendee | null;
  existingByKey: Map<string, ListingAttendeeRow>;
};

/** Create mode has no attendee, lines, or questions to preload. */
const EMPTY_EDIT_CONTEXT: EditContext = {
  attendee: null,
  existingByKey: new Map(),
  ...emptySelectedQuestionAnswers(),
};

/** Edit mode: load the attendee, its existing lines (indexed by key), and its
 * question/answer context. Returns null when the attendee does not exist. */
const loadEditContext = async (
  attendeeId: number,
): Promise<EditContext | null> => {
  const loaded = await loadAttendeeForEdit(attendeeId);
  if (!loaded) return null;
  const { questions, selectedAnswerIds, selectedTextAnswers } =
    await loadQuestionsForExisting(attendeeId, loaded.existing);
  return {
    attendee: loaded.attendee,
    existingByKey: new Map(
      loaded.existing.map(({ key, booking }) => [key, booking]),
    ),
    questions,
    selectedAnswerIds,
    selectedTextAnswers,
  };
};

/** Re-render the submitted form in place: the bare create page in create
 * mode, the entity page's Edit tab in edit mode — entered values and their
 * errors survive deterministically, with no redirect or stash involved. */
const renderSubmittedForm = (
  session: AuthSession,
  data: AttendeeFormTemplateData,
): Promise<Response> =>
  // A null attendee is exactly create mode — the standalone page.
  data.attendee === null
    ? Promise.resolve(htmlResponse(attendeeFormPage(data, session)))
    : attendeePage.renderPage(session, data.attendee.id, "edit", {
        sections: () =>
          Promise.resolve([
            { html: AttendeeFormPanel({ data }), kind: "custom" as const },
          ]),
      });

/** Common submit handler for create + edit. `attendeeId` is null in create. */
const handleSubmit =
  (mode: "create" | "edit", attendeeId: number | null) =>
  (request: Request): Promise<Response> =>
    withAuth(request, AUTH_FORM, (session, form) =>
      handleSubmitInner(mode, attendeeId, session, form),
    );

/** Inner submit logic — parse, validate, then run the atomic create or edit. */
const handleSubmitInner = async (
  mode: "create" | "edit",
  attendeeId: number | null,
  session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const edit = await loadAfterDemoOverrides(form, ATTENDEE_DEMO_FIELDS, () =>
    mode === "edit" && attendeeId !== null
      ? loadEditContext(attendeeId)
      : Promise.resolve(EMPTY_EDIT_CONTEXT),
  );
  if (edit === null) return notFoundResponse();
  const {
    attendee,
    existingByKey,
    questions,
    selectedAnswerIds,
    selectedTextAnswers,
  } = edit;

  // A staged checkout's rows are claimed by the payment when it lands; editing
  // them mid-payment would strand the paid order. Fail closed until the payment
  // finishes. The Edit tab is hidden while pending (so it can't re-render the
  // refusal in place, and would 404 as the failure target) — a submission that
  // raced the checkout redirects to the always-visible overview instead, where
  // the banner explains the locked state.
  if (attendee !== null && (await hasPendingCheckout(attendee.id))) {
    return redirect(
      attendeePage.path(attendee.id, ""),
      t("attendee_form.error_pending_checkout"),
      false,
    );
  }

  const listingsById = byId(await getAllListings());
  // Coerce a missing/blank status back to the public default (the form offers
  // no "no status" choice) — the same resolver the template pre-selects with.
  const statuses = await attendeeStatuses.getAll();
  const rawParsed = parseAttendeeForm(
    form,
    listingsById,
    existingByKey,
    packagesByListingIdFrom(await loadPackagePaths()),
  );
  const parsed: ParsedAttendeeForm = {
    ...rawParsed,
    statusId: resolveStatusId(rawParsed.statusId, statuses),
  };
  const renderOpts = {
    questions,
    returnUrl: parsed.returnUrl,
    selectedAnswerIds,
    selectedTextAnswers,
  };

  const lockedDeletedBookings = new Map(
    [...existingByKey].filter(
      ([, booking]) => !listingsById.has(booking.listing_id),
    ),
  );
  const result = validateParsedForm(parsed, lockedDeletedBookings);
  // Re-render the submitted form in place with the given errors merged onto
  // the render options — the validation and save failure paths share this.
  const showErrors = async (
    errors: Parameters<typeof buildTemplateData>[3],
  ): Promise<Response> =>
    renderSubmittedForm(
      session,
      await buildTemplateData(mode, result.values, attendee, {
        ...renderOpts,
        ...errors,
      }),
    );
  if (!result.valid) {
    return showErrors({
      attendeeError: result.attendeeError?.message ?? null,
      dateError: result.dateError,
      formError: result.formError,
    });
  }

  // The logistics plan is read from the submitted agent selects (only when the
  // feature is on); it is applied after the booking rows exist.
  const logisticsPlan = settings.hasLogistics
    ? parseLogisticsPlan(
        form,
        parsed.lines,
        new Set((await logisticsAgents.getAll()).map((a) => a.id)),
      )
    : null;

  // Apply atomic create or edit. On a recoverable failure (capacity, no lines)
  // re-render the submitted form in place so entered data is never lost.
  const outcome =
    mode === "create"
      ? await applyCreate(parsed, logisticsPlan)
      : await applyEdit(
          attendeeId!,
          parsed,
          attendee!,
          questions,
          parseQuestionAnswers({ optional: true })(form, questions),
          logisticsPlan,
          existingByKey,
        );
  if (outcome.ok) return outcome.response;
  return showErrors({ saveError: outcome.saveError });
};

/** Outcome of an atomic create/edit attempt. */
type SaveOutcome =
  | { ok: true; response: Response }
  | { ok: false; saveError: string };

/**
 * True when any no-quantity line satisfies a check, judged from the live DB (not
 * the form's submitted key). Used by applyEdit to block marking a line
 * no-quantity while it still holds an assigned built site (the assignment +
 * public /renew/ path would survive behind a hidden line) or a recorded payment
 * (a stale form key would otherwise hide the booking from the per-line model
 * guard and let the atomic edit drop the paid row). One query over all the IDs.
 */
const anyNoQuantityLineMatches = (
  attendeeId: number,
  lines: AttendeeFormLine[],
  check: (attendeeId: number, listingIds: number[]) => Promise<boolean>,
): Promise<boolean> => {
  const listingIds = lines.filter(isNoQuantityLine).map((l) => l.listingId);
  return listingIds.length > 0
    ? check(attendeeId, listingIds)
    : Promise.resolve(false);
};

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

/** Run the all-or-nothing atomic create flow. */
const applyCreate = async (
  parsed: ParsedAttendeeForm,
  logisticsPlan: LogisticsPlan,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { ok: false, saveError: t("attendee_form.error_no_lines") };
  }
  // Admin manual add may deliberately overbook (a warning is shown, not blocked)
  // and is tagged as an "admin" booking so it counts separately from online
  // checkouts in the contact's booking history. The ledger poster records the
  // booking's gross `sale` legs in the SAME create transaction, so the owed
  // amount projects from the ledger (rather than silently reading back as £0)
  // and lands atomically with the rows. The attendee owes the full gross; an
  // operator records any already-paid portion afterwards through the ledger.
  const createResult = await createAttendeeAtomic(
    {
      ...input,
      allowOverbook: true,
      source: "admin",
    },
    manualAddLedgerPoster(toLedgerOrder(parsed)),
  );
  if (!createResult.success) {
    return { ok: false, saveError: t("attendee_form.error_capacity") };
  }
  const { attendees } = createResult;
  const firstListingId = input.bookings[0]!.listingId;
  const newId = attendees[0]!.id;
  await applyLogisticsPlan(newId, logisticsPlan);
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

/** Run the atomic edit flow. */
const applyEdit = async (
  attendeeId: number,
  parsed: ParsedAttendeeForm,
  attendee: Attendee,
  questions: QuestionWithAnswers[],
  answers: AttendeeAnswerSet,
  logisticsPlan: LogisticsPlan,
  existingByKey: Map<string, ListingAttendeeRow>,
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
  // A save can't strip the in-app refund path while money is still ours to
  // return — refund first. Two ways it would, both refused with the same message:
  //  - marking a SALE-backed line no-quantity (hasPaidLine, even when a stale
  //    form key hid the existing booking from the per-line model guard); or
  //  - removing the active home line while the attendee holds a stage_active
  //    conflict's un-refunded cash. That cash has no sale leg, so hasPaidLine
  //    misses it, and the refund route needs an active home line
  //    (canRefundAttendee → hasActiveBookingLine). Only a save that REMOVES that
  //    line (marks it no-quantity, zeroes it, or omits it) strands the cash; a
  //    save that keeps an active home line leaves the refund path intact, so the
  //    operator can still fix the quantities the conflict note asks about.
  const keepsHomeRefundLine = parsed.lines.some(
    (line) =>
      line.listingId === attendee.listing_id &&
      line.quantity !== null &&
      line.quantity >= 1,
  );
  if (
    (await anyNoQuantityLineMatches(attendeeId, parsed.lines, hasPaidLine)) ||
    (!keepsHomeRefundLine && (await attendeeHoldsUnreturnedCash(attendeeId)))
  ) {
    return { ok: false, saveError: t("attendee_form.error_paid_no_qty") };
  }

  // The Edit tab has no location inputs, so the Logistics pin survives only
  // while the address it was pinned for stays the same — an edit that changes
  // the address clears the now-stale pin (a fresh one is set on the
  // Logistics tab).
  const addressUnchanged = parsed.address === attendee.address;
  const encryptedPiiBlob = (await encryptPiiBlob(
    buildPiiBlob({
      address: parsed.address,
      email: parsed.email,
      lat: addressUnchanged ? attendee.lat : "",
      lng: addressUnchanged ? attendee.lng : "",
      name: parsed.name,
      payment_id: attendee.payment_id,
      phone: parsed.phone,
      special_instructions: parsed.special_instructions,
      ticket_token: attendee.ticket_token,
    }),
    settings.publicKey,
  ))!;

  const desired = toDesiredLines(parsed);
  // Admin manual edit may deliberately overbook (warned, not blocked).
  const editResult = await applyAttendeeAtomicEdit(
    attendeeId,
    encryptedPiiBlob,
    desired,
    true,
  );
  if (!editResult.success) {
    if (editResult.reason === "no_lines") {
      return { ok: false, saveError: t("attendee_form.error_no_lines") };
    }
    return { ok: false, saveError: t("attendee_form.error_capacity") };
  }

  // The edit form only writes the status; the outstanding balance projects from
  // the ledger and is adjusted there, never from this form. The one exception is
  // a save that leaves no payable line: its stranded receivable (which the
  // public pay gate would refuse) is cleared to 0 alongside the status write.
  const hasRealLine = desired.some((line) => line.quantity > 0);
  await updateAttendeeStatus(attendeeId, parsed.statusId, !hasRealLine);

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
      t("attendee_form.saved_updated", { value: parsed.name }),
    ),
  };
};

// ---------------------------------------------------------------------------
// POST route exports
// ---------------------------------------------------------------------------

/** Handle POST /admin/attendees/new — create a new attendee. */
export const handleAttendeeNewPost: TypedRouteHandler<"POST /admin/attendees/new"> =
  handleSubmit("create", null);

/** Handle POST /admin/attendees/:attendeeId — update an existing attendee. */
export const handleAttendeeEditPost: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId"
> = (request, { attendeeId }) => handleSubmit("edit", attendeeId)(request);
