/**
 * Routes for the unified add/edit attendee page.
 *
 *   GET  /admin/attendees/new      — render empty form (create mode)
 *   POST /admin/attendees/new      — handle create submission
 *   GET  /admin/attendees/:id      — render form preloaded with attendee (edit mode)
 *   POST /admin/attendees/:id      — handle edit submission
 *
 * Create and edit share every step:
 *   1. Load available listings + (edit only) current attendee/lines.
 *   2. Parse the form into attendee + line items.
 *   3. If the operator clicked add-line / remove-line, re-render without
 *      saving (preserve all entered data).
 *   4. Otherwise validate. On failure, re-render with line-level errors.
 *   5. Run the atomic create or update.
 *   6. Redirect with a success/failure flash.
 */

import { filter, map, pipe, unique } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  attendeeBalanceNotice,
  type DailyDefaults,
  defaultNewDailyDate,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  resolveDailyDefaults,
  toCreateInput,
  toDesiredLines,
  trimTrailingBlankLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
/* jscpd:ignore-start */
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getAttendeeActivityLog, logActivity } from "#shared/db/activityLog.ts";
/* jscpd:ignore-end */
import { getAllAttendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import {
  applyAttendeeAtomicEdit,
  buildPiiBlob,
  type CreateAttendeeResult,
  createAttendeeAtomic,
  type ExistingLine,
  encryptPiiBlob,
  ensureAllBookings,
  getAttendee,
  type ListingAttendeeRow,
  loadExistingLines,
  updateAttendeeOrder,
} from "#shared/db/attendees.ts";
import {
  type EmailStats,
  getEmailStats,
  hashEmail,
} from "#shared/db/email-preferences.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  loadAttendeeQuestionData,
  parseQuestionAnswers,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  type Attendee,
  availableDayCounts,
  type Holiday,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  type AttendeeFormTemplateData,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";

// ---------------------------------------------------------------------------
// Shared loaders / helpers
// ---------------------------------------------------------------------------

/** Listings selectable in the dropdown: active listings plus any currently
 * selected listings (so an inactive selected listing still renders its name). */
const getListingsForSelector = async (
  parsed: ParsedAttendeeForm | null,
): Promise<ListingWithCount[]> => {
  const allListings = await getAllListings();
  const active = filter((l: ListingWithCount) => l.active)(allListings);
  if (!parsed) return active;
  const selectedIds = new Set(
    pipe(
      map((line: AttendeeFormLine) => line.listingId),
      filter((id: number) => id > 0),
    )(parsed.lines),
  );
  // Active and selected-inactive are disjoint (one is active, the other not),
  // so concatenating them needs no de-duplication.
  const selectedInactive = filter(
    (l: ListingWithCount) => selectedIds.has(l.id) && !l.active,
  )(allListings);
  return [...selectedInactive, ...active];
};

/** Index listings by id for line resolution. */
const listingsByIdMap = (
  listings: ListingWithCount[],
): Map<number, ListingWithCount> => new Map(listings.map((l) => [l.id, l]));

/** Build the available-dates map for every daily listing in the selector. */
const buildAvailableDates = (
  listings: ListingWithCount[],
  holidays: Holiday[],
): Record<number, string[]> => {
  const result: Record<number, string[]> = {};
  for (const listing of listings) {
    if (listing.listing_type === "daily") {
      result[listing.id] = getBookableStartDates(listing, holidays);
    }
  }
  return result;
};

/** Offered day counts per customisable daily listing, for the day-count picker. */
const buildCustomisableDayCounts = (
  listings: ListingWithCount[],
): Record<number, number[]> => {
  const result: Record<number, number[]> = {};
  for (const listing of listings) {
    if (listing.customisable_days && listing.listing_type === "daily") {
      result[listing.id] = availableDayCounts(listing);
    }
  }
  return result;
};

/** A fresh, empty listing line. The daily date defaults to the attendee's
 * shared start date when the existing daily lines are uniform, otherwise to
 * tomorrow — so a daily row never starts with an empty date. */
const emptyLine = (
  todayIso: string,
  inheritedDate: string | null,
): AttendeeFormLine => ({
  date: inheritedDate ?? defaultNewDailyDate(todayIso),
  dayCount: null,
  error: null,
  existingBooking: null,
  key: "",
  listing: null,
  listingId: 0,
  quantity: 1,
});

/** Build the empty create-mode form shell: one blank line with the
 * default daily date pre-filled (so the operator sees a concrete date). */
const buildEmptyCreateForm = (): ParsedAttendeeForm => ({
  action: { kind: "save" },
  address: "",
  email: "",
  lines: [emptyLine(todayInTz(settings.timezone), null)],
  name: "",
  phone: "",
  remainingBalance: 0,
  returnUrl: "",
  special_instructions: "",
  statusId: null,
});

/** Build the edit-mode form shell from a loaded attendee + its bookings. */
const buildEditFormFromAttendee = (
  attendee: Attendee,
  existing: ExistingLine[],
  listingsById: Map<number, ListingWithCount>,
): ParsedAttendeeForm => {
  const lines: AttendeeFormLine[] = existing.map(({ key, booking }) => {
    const listing = listingsById.get(booking.listing_id) ?? null;
    return {
      date: booking.start_at?.slice(0, 10) ?? "",
      dayCount: null,
      error: null,
      existingBooking: booking,
      key,
      listing,
      listingId: booking.listing_id,
      quantity: booking.quantity,
    };
  });
  // Always append one blank line so the operator has somewhere to type a new
  // registration without clicking "Add Listing Line" first. It inherits the
  // attendee's shared daily date when the existing daily lines are uniform.
  lines.push(
    emptyLine(
      todayInTz(settings.timezone),
      resolveDailyDefaults(lines).inheritedDate,
    ),
  );
  return {
    action: { kind: "save" },
    address: attendee.address || "",
    email: attendee.email || "",
    lines,
    name: attendee.name,
    phone: attendee.phone || "",
    remainingBalance: attendee.remaining_balance,
    returnUrl: "",
    special_instructions: attendee.special_instructions || "",
    statusId: attendee.status_id,
  };
};

/** How many of an attendee's activity-log entries to show on the edit page.
 * High enough to be "all of them" for any real attendee. */
const ATTENDEE_LOG_LIMIT = 1000;

/** Build the template data for re-rendering the form. */
const buildTemplateData = async (
  mode: "create" | "edit",
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
  opts: {
    attendeeError?: string | null;
    flashError?: string;
    flashSuccess?: string;
    returnUrl?: string;
    questions?: QuestionWithAnswers[];
    selectedAnswerIds?: number[];
    emailStats?: EmailStats | null;
  } = {},
): Promise<AttendeeFormTemplateData> => {
  const allListings = await getListingsForSelector(parsed);
  const holidays = await getActiveHolidays();
  const availableDatesByListing = buildAvailableDates(allListings, holidays);
  const customisableByListing = buildCustomisableDayCounts(allListings);
  const dailyDefaults: DailyDefaults = resolveDailyDefaults(parsed.lines);
  const statuses = await getAllAttendeeStatuses();
  // Surface a status/balance mismatch. The order totals come from the saved
  // booking (edit only); in create mode there is nothing paid yet.
  const summary = attendee ? await getAttendeeOrderSummary(attendee.id) : null;
  const balanceNotice = attendeeBalanceNotice(
    statuses.find((s) => s.id === parsed.statusId) ?? null,
    parsed.remainingBalance,
    summary?.fullPrice ?? 0,
    summary?.depositPaid ?? 0,
  );
  // The read-only summary (detail table + activity log) is edit-only; create
  // mode has no attendee to summarise yet.
  const activityLog = attendee
    ? await getAttendeeActivityLog(attendee.id, ATTENDEE_LOG_LIMIT)
    : [];
  return {
    activityLog,
    allListings,
    allowedDomain: getEffectiveDomain(),
    attendee,
    attendeeError: opts.attendeeError ?? null,
    availableDatesByListing,
    balanceNotice,
    customisableByListing,
    dailyDefaults,
    emailStats: opts.emailStats ?? null,
    flashError: opts.flashError,
    flashSuccess: opts.flashSuccess,
    mode,
    parsed,
    phonePrefix: settings.phonePrefix,
    questions: opts.questions ?? [],
    returnUrl: opts.returnUrl,
    selectedAnswerIds: opts.selectedAnswerIds ?? [],
    statuses,
    todayIso: todayInTz(settings.timezone),
  };
};

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's booked listings (edit mode only). Rendering and saving every
 * listing's questions — not just the first — is what keeps the save from wiping
 * answers tied to the attendee's other listings: answers are stored per
 * attendee, so the submitted set must cover every question it can have
 * answered. */
const loadQuestionsForExisting = async (
  attendeeId: number,
  existing: ExistingLine[],
): Promise<{
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
}> => {
  const listingIds = unique(existing.map((e) => e.booking.listing_id));
  const data = await loadAttendeeQuestionData(listingIds, [attendeeId]);
  if (!data) return { questions: [], selectedAnswerIds: [] };
  return {
    questions: data.questions,
    selectedAnswerIds: data.attendeeAnswerMap.get(attendeeId) ?? [],
  };
};

/** Render the attendee form page as an HTML response. */
const renderForm = (
  session: AuthSession,
  data: AttendeeFormTemplateData,
): Response => htmlResponse(attendeeFormPage(data, session));

/** Render a GET of the form, surfacing any post-save flash (cookie) inside the
 * form so the operator lands on it after the redirect. */
const renderAttendeeFormPage = (
  request: Request,
  data: AttendeeFormTemplateData,
  session: AuthSession,
): Response => {
  const flash = applyFlash(request);
  return renderForm(session, {
    ...data,
    flashError: flash.error,
    flashSuccess: flash.success,
  });
};

// ---------------------------------------------------------------------------
// GET /admin/attendees/new  (and GET /admin/attendees/:id)
// ---------------------------------------------------------------------------

/** Handle GET /admin/attendees/new — render the empty create form. */
export const handleAttendeeNewGet: TypedRouteHandler<
  "GET /admin/attendees/new"
> = (request) =>
  requireSessionOr(request, async (session) => {
    const parsed = buildEmptyCreateForm();
    const data = await buildTemplateData("create", parsed, null, {
      returnUrl: getSearchParam(request, "return_url"),
    });
    return renderAttendeeFormPage(request, data, session);
  });

/** Handle GET /admin/attendees/:id — render the edit form preloaded. */
export const handleAttendeeEditGet: TypedRouteHandler<
  "GET /admin/attendees/:attendeeId"
> = (request, { attendeeId }) =>
  requireSessionOr(request, async (session) => {
    const loaded = await loadAttendeeForEdit(session, attendeeId);
    if (!loaded) return notFoundResponse();
    const allListings = await getListingsForSelector(null);
    const listingsById = listingsByIdMap(allListings);
    const parsed = buildEditFormFromAttendee(
      loaded.attendee,
      loaded.existing,
      listingsById,
    );
    const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
      attendeeId,
      loaded.existing,
    );
    const emailStats = await loadEmailStats(session, loaded.attendee);
    const data = await buildTemplateData("edit", parsed, loaded.attendee, {
      emailStats,
      questions,
      returnUrl: getSearchParam(request, "return_url"),
      selectedAnswerIds,
    });
    return renderAttendeeFormPage(request, data, session);
  });

/** Read the attendee's bulk-email contact history (null when no email on
 * file). Reused by the edit page to show the "Email History" section. */
const loadEmailStats = async (
  session: AuthSession,
  attendee: Attendee,
): Promise<EmailStats | null> => {
  if (!attendee.email) return null;
  const pk = await requirePrivateKey(session);
  return getEmailStats(await hashEmail(attendee.email), pk);
};

/** Load an attendee + all its listing_attendees rows for the edit page. */
const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{ attendee: Attendee; existing: ExistingLine[] } | null> => {
  const pk = await requirePrivateKey(session);
  // PII-only load; the per-listing lines come from loadExistingLines, so no join.
  const attendee = await getAttendee(attendeeId, pk);
  if (!attendee) return null;
  const existing = await loadExistingLines(attendeeId);
  return { attendee, existing };
};

/** Everything the submit handler needs about an attendee being edited. */
type EditContext = {
  attendee: Attendee | null;
  existingByKey: Map<string, ListingAttendeeRow>;
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
};

/** Create mode has no attendee, lines, or questions to preload. */
const EMPTY_EDIT_CONTEXT: EditContext = {
  attendee: null,
  existingByKey: new Map(),
  questions: [],
  selectedAnswerIds: [],
};

/** Edit mode: load the attendee, its existing lines (indexed by key), and its
 * question/answer context. Returns null when the attendee does not exist. */
const loadEditContext = async (
  session: AuthSession,
  attendeeId: number,
): Promise<EditContext | null> => {
  const loaded = await loadAttendeeForEdit(session, attendeeId);
  if (!loaded) return null;
  const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
    attendeeId,
    loaded.existing,
  );
  return {
    attendee: loaded.attendee,
    existingByKey: new Map(
      loaded.existing.map(({ key, booking }) => [key, booking]),
    ),
    questions,
    selectedAnswerIds,
  };
};

// ---------------------------------------------------------------------------
// POST handlers — shared submit logic
// ---------------------------------------------------------------------------

/** Apply add-line / remove-line transformations to a parsed form.
 *
 * Both actions are pure form-state edits — nothing is written to the
 * database. Removing an existing line just drops it from the form; the actual
 * `listing_attendees` delete happens when the operator saves (the atomic update
 * diffs it out). That keeps removal part of the one logical "save the whole
 * attendee" submission, so other typed-in changes are never lost to a
 * mid-edit redirect. A newly added line inherits the attendee's shared daily
 * start date when the existing daily lines are uniform.
 *
 * Returns `{ kind: "save" }` when the action was a plain save. */
const applyLineAction = (
  parsed: ParsedAttendeeForm,
  todayIso: string,
): { kind: "rerender"; parsed: ParsedAttendeeForm } | { kind: "save" } => {
  const action = parsed.action;
  if (action.kind === "add_line") {
    const inherited = resolveDailyDefaults(parsed.lines).inheritedDate;
    return {
      kind: "rerender",
      parsed: {
        ...parsed,
        lines: [...parsed.lines, emptyLine(todayIso, inherited)],
      },
    };
  }
  if (action.kind === "remove_line") {
    const lines = parsed.lines.filter((_, i) => i !== action.index);
    return {
      kind: "rerender",
      parsed: {
        ...parsed,
        lines: lines.length > 0 ? lines : [emptyLine(todayIso, null)],
      },
    };
  }
  return { kind: "save" };
};

/** Common submit handler for create + edit. `attendeeId` is null in create
 * mode.
 *
 * This uses `withAuth` directly rather than the `createAuthedFormRoute` factory
 * the simpler admin forms use: a single POST here can mean add-line, remove-line,
 * or save, and the non-save actions must re-render the in-progress form without
 * validating or persisting. That preserve-and-rerender, multi-action flow does
 * not fit the factory's validate→onValid/onInvalid shape, so the control flow
 * lives here explicitly. */
const handleSubmit =
  (mode: "create" | "edit", attendeeId: number | null) =>
  (request: Request): Promise<Response> =>
    withAuth(request, AUTH_FORM, (session, form) =>
      handleSubmitInner(mode, attendeeId, session, form),
    );

/** Inner submit logic — extracted so the create/edit wrappers can pass
 * their own identity without conditionals in the hot path. */
const handleSubmitInner = async (
  mode: "create" | "edit",
  attendeeId: number | null,
  session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

  // Load attendee + existing lines + question context (edit mode only).
  const edit =
    mode === "edit" && attendeeId !== null
      ? await loadEditContext(session, attendeeId)
      : EMPTY_EDIT_CONTEXT;
  if (edit === null) return notFoundResponse();
  const { attendee, existingByKey, questions, selectedAnswerIds } = edit;

  const allListings = await getAllListings();
  const listingsById = listingsByIdMap(allListings);
  const parsed = parseAttendeeForm(form, listingsById, existingByKey);
  const renderOpts = {
    questions,
    returnUrl: parsed.returnUrl,
    selectedAnswerIds,
  };

  // Step 1: line-action re-render (no save).
  const todayIso = todayInTz(settings.timezone);
  const lineAction = applyLineAction(parsed, todayIso);
  if (lineAction.kind === "rerender") {
    return renderForm(
      session,
      await buildTemplateData(mode, lineAction.parsed, attendee, renderOpts),
    );
  }

  // Step 2: trim trailing blank lines so save validation doesn't fail on
  // the placeholder row.
  const trimmed: ParsedAttendeeForm = {
    ...parsed,
    lines: trimTrailingBlankLines(parsed.lines),
  };

  // Step 3: validate attendee + every line.
  const holidays = await getActiveHolidays();
  const result = validateParsedForm(trimmed, holidays);
  const dataForRerender = await buildTemplateData(
    mode,
    result.values,
    attendee,
    renderOpts,
  );
  if (!result.valid) {
    const attendeeError = result.attendeeError?.message ?? null;
    return renderForm(session, { ...dataForRerender, attendeeError });
  }

  // Step 4: apply atomic create or edit. On a recoverable failure (capacity,
  // encryption, no lines) re-render the submitted form in place so the
  // operator never loses entered data, marking the failing line where known.
  const outcome =
    mode === "create"
      ? await applyCreate(parsed)
      : await applyEdit(
          attendeeId!,
          parsed,
          attendee!,
          questions,
          // Admin edit treats answers as optional — keep only the valid ones.
          parseQuestionAnswers({ optional: true })(form, questions).answerIds,
        );
  if (outcome.ok) return outcome.response;
  // In-place re-render (no redirect): show the failure inside the form, the
  // same place a saved success lands, while preserving the entered data.
  return renderForm(session, {
    ...dataForRerender,
    flashError: outcome.flashError,
  });
};

/** Outcome of an atomic create/edit attempt. A recoverable failure carries
 * the flash to show; the submit handler re-renders the submitted form in
 * place so no entered data is lost. */
type SaveOutcome =
  | { ok: true; response: Response }
  | { ok: false; flashError: string };

/** Shown when a submission has no usable listing lines. */
const NO_LINES_ERROR = "Add at least one listing line before saving";

/** Shown when capacity can't fit the submitted lines. One wording for both the
 * create and edit paths so the operator never sees two phrasings of the same
 * failure. */
const CAPACITY_SAVE_ERROR =
  "Not enough spots available for one or more selected listings — nothing was saved. Please review your listing lines and try again.";

/** The edit page for an attendee, carrying the return_url through so the
 * "Back without saving" link still works after a save. */
const attendeePath = (id: number, returnUrl: string): string =>
  returnUrl
    ? `/admin/attendees/${id}?return_url=${encodeURIComponent(returnUrl)}`
    : `/admin/attendees/${id}`;

/** Redirect back to the saved attendee's own form, scrolling to it via the
 * `#attendee-form` anchor; the flash cookie then shows the success inside it. */
const savedRedirect = (
  id: number,
  returnUrl: string,
  message: string,
): Response =>
  redirect(`${attendeePath(id, returnUrl)}#${ATTENDEE_FORM_ID}`, message, true);

/** Run the atomic create flow. All-or-nothing: `ensureAllBookings` rolls the
 * attendee back unless every submitted line fits, so a partial booking never
 * shows a misleading success. */
const applyCreate = async (
  parsed: ParsedAttendeeForm,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { flashError: NO_LINES_ERROR, ok: false };
  }
  const createResult = await createAttendeeAtomic(input);
  const check = await ensureAllBookings(createResult, input.bookings.length);
  if (!check.ok) {
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
  }
  // ensureAllBookings guarantees full success past the ok check.
  const { attendees } = createResult as Extract<
    CreateAttendeeResult,
    { success: true }
  >;

  // input.bookings is non-empty (guarded above) and every booking comes from a
  // fillable line, so its listing id is always present — no re-scan needed.
  const firstListingId = input.bookings[0]!.listingId;
  const newId = attendees[0]!.id;
  await logActivity(
    `Attendee '${parsed.name}' added manually`,
    firstListingId,
    newId,
  );

  return {
    ok: true,
    response: savedRedirect(newId, parsed.returnUrl, `Added ${parsed.name}`),
  };
};

/** Run the atomic edit flow. */
const applyEdit = async (
  attendeeId: number,
  parsed: ParsedAttendeeForm,
  attendee: Attendee,
  questions: QuestionWithAnswers[],
  answerIds: number[],
): Promise<SaveOutcome> => {
  // Re-encrypt the PII blob with the (possibly) updated fields and pass it as
  // one statement of the atomic batch. Encryption can't realistically fail
  // (it would mean the whole app is broken), so we don't branch on it.
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
  const editResult = await applyAttendeeAtomicEdit(
    attendeeId,
    encryptedPiiBlob,
    desired,
  );
  if (!editResult.success) {
    if (editResult.reason === "no_lines") {
      return { flashError: NO_LINES_ERROR, ok: false };
    }
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
  }

  // Status + outstanding balance are plaintext, operator-editable columns;
  // persist them once the line/PII edit has committed.
  await updateAttendeeOrder(
    attendeeId,
    parsed.statusId,
    parsed.remainingBalance,
  );

  // Save question answers (atomic delete + insert) when the listing has any.
  if (questions.length > 0) {
    await saveAttendeeAnswers(new Map([[attendeeId, answerIds]]));
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
      `Updated ${parsed.name}`,
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
