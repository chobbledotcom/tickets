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
 * deliberately not a stash-dependent bounce (edit-pages.md).
 */

import { t } from "#i18n";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  isBookedLine,
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
  getRenderListings,
  listingsByIdMap,
  loadAttendeeForEdit,
  loadQuestionsForExisting,
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
import { getAllAttendeeStatuses } from "#shared/db/attendee-statuses.ts";
import {
  applyAttendeeAtomicEdit,
  buildPiiBlob,
  type CreateAttendeeResult,
  createAttendeeAtomic,
  encryptPiiBlob,
  ensureAllBookings,
  hasPaidLine,
  type ListingAttendeeRow,
  updateAttendeeOrder,
} from "#shared/db/attendees.ts";
import { hasAssignedBuiltSite } from "#shared/db/built-sites.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import {
  parseQuestionAnswers,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  selectedListingQuantities,
  selectedStartDate,
} from "#shared/order-select.ts";
import type { Attendee } from "#shared/types.ts";
import {
  AttendeeFormPanel,
  type AttendeeFormTemplateData,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";

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
type EditContext = {
  attendee: Attendee | null;
  existingByKey: Map<string, ListingAttendeeRow>;
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  selectedTextAnswers: Map<number, string>;
};

/** Create mode has no attendee, lines, or questions to preload. */
const EMPTY_EDIT_CONTEXT: EditContext = {
  attendee: null,
  existingByKey: new Map(),
  questions: [],
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
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
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

  const edit =
    mode === "edit" && attendeeId !== null
      ? await loadEditContext(attendeeId)
      : EMPTY_EDIT_CONTEXT;
  if (edit === null) return notFoundResponse();
  const {
    attendee,
    existingByKey,
    questions,
    selectedAnswerIds,
    selectedTextAnswers,
  } = edit;

  const listingsById = listingsByIdMap(await getAllListings());
  // Coerce a missing/blank status back to the public default (the form offers
  // no "no status" choice) — the same resolver the template pre-selects with.
  const statuses = await getAllAttendeeStatuses();
  const rawParsed = parseAttendeeForm(form, listingsById, existingByKey);
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

  const result = validateParsedForm(parsed);
  if (!result.valid) {
    return renderSubmittedForm(
      session,
      await buildTemplateData(mode, result.values, attendee, {
        ...renderOpts,
        attendeeError: result.attendeeError?.message ?? null,
        dateError: result.dateError,
        formError: result.formError,
      }),
    );
  }

  // The logistics plan is read from the submitted agent selects (only when the
  // feature is on); it is applied after the booking rows exist.
  const logisticsPlan = settings.hasLogistics
    ? parseLogisticsPlan(
        form,
        parsed.lines,
        new Set((await getAllLogisticsAgents()).map((a) => a.id)),
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
        );
  if (outcome.ok) return outcome.response;
  return renderSubmittedForm(
    session,
    await buildTemplateData(mode, result.values, attendee, {
      ...renderOpts,
      saveError: outcome.saveError,
    }),
  );
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

/** Run the atomic create flow. All-or-nothing via `ensureAllBookings`. */
const applyCreate = async (
  parsed: ParsedAttendeeForm,
  logisticsPlan: LogisticsPlan,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { ok: false, saveError: t("attendee_form.error_no_lines") };
  }
  // A no-quantity-only attendee has no real line to pay into, so never give it an
  // unpayable balance (the public pay gate refuses such attendees).
  const hasRealLine = parsed.lines.some(isBookedLine);
  // Admin manual add may deliberately overbook (a warning is shown, not blocked)
  // and is tagged as an "admin" booking so it counts separately from online
  // checkouts in the contact's booking history. The ledger poster records the
  // booking's gross `sale` legs and reconciles the entered outstanding balance in
  // the SAME create transaction, so the owed amount projects from the ledger
  // (rather than silently reading back as £0) and lands atomically with the rows.
  // A no-quantity-only add has no real line to pay into, so reconcile the balance
  // to 0 rather than record a receivable the public pay gate could never settle.
  const createResult = await createAttendeeAtomic(
    {
      ...input,
      allowOverbook: true,
      source: "admin",
    },
    manualAddLedgerPoster(
      toLedgerOrder(parsed),
      hasRealLine ? input.remainingBalance : 0,
    ),
  );
  const check = await ensureAllBookings(
    createResult,
    input.bookings.length,
    "admin",
  );
  if (!check.ok) {
    return { ok: false, saveError: t("attendee_form.error_capacity") };
  }
  const { attendees } = createResult as Extract<
    CreateAttendeeResult,
    { success: true }
  >;
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
  answers: import("#shared/db/questions.ts").AttendeeAnswerSet,
  logisticsPlan: LogisticsPlan,
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

  const encryptedPiiBlob = (await encryptPiiBlob(
    buildPiiBlob({
      address: parsed.address,
      email: parsed.email,
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

  // When the save leaves no real line the public pay gate refuses payment, so
  // reconcile the ledger balance to 0 rather than strand an unpayable receivable
  // on a ghost; otherwise reconcile to the entered balance. The reconcile posts a
  // writeoff leg, which is itself the audit record of the clear. Same predicate as
  // applyCreate — only booked lines survive into `desired` with quantity > 0.
  const hasRealLine = parsed.lines.some(isBookedLine);
  await updateAttendeeOrder(
    attendeeId,
    parsed.statusId,
    hasRealLine ? parsed.remainingBalance : 0,
  );

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
