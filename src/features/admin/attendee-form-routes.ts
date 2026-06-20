/**
 * Routes for the unified add/edit attendee page.
 *
 *   GET  /admin/attendees/new      — render the create form
 *   POST /admin/attendees/new      — handle create submission
 *   GET  /admin/attendees/:id      — render the edit form, preloaded
 *   POST /admin/attendees/:id      — handle edit submission
 *
 * The editor is a fixed table — one quantity box per bookable listing (plus any
 * inactive listing the attendee already booked) — and one shared date range, so
 * a submission is a single self-contained save with no add/remove-line round
 * trips. Create can be deep-linked from the calendar availability checker with
 * `?select_<id>=1&start_date=…` to pre-fill the chosen listings and date.
 */

/* jscpd:ignore-start */
import { compact, filter, unique } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import {
  ATTENDEE_FORM_ID,
  type AttendeeFormLine,
  attendeeBalanceNotice,
  isBookedLine,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  resolveSharedDates,
  resolveStatusId,
  toCreateInput,
  toDesiredLines,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  buildAttendeeLogisticsData,
  parseLogisticsPlan,
} from "#routes/admin/attendee-logistics.ts";
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
import { getEffectiveDomain } from "#shared/config.ts";
import { getAttendeeActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { getAllAttendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import {
  applyAttendeeAtomicEdit,
  buildPiiBlob,
  type CreateAttendeeResult,
  checkLinesCapacity,
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
  type ContactStats,
  getContactStats,
  hashEmail,
  hashPhone,
  recordBookingStats,
  saveContactAdminNotes,
} from "#shared/db/contact-preferences.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import {
  loadAttendeeQuestionData,
  parseQuestionAnswers,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  parseSelectedListingIds,
  START_DATE_FIELD,
} from "#shared/order-select.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  type AttendeeFormTemplateData,
  attendeeFormPage,
} from "#templates/admin/attendee-form.tsx";

/* jscpd:ignore-end */

// ---------------------------------------------------------------------------
// Shared loaders / helpers
// ---------------------------------------------------------------------------

/** Index listings by id. */
const listingsByIdMap = (
  listings: ListingWithCount[],
): Map<number, ListingWithCount> => new Map(listings.map((l) => [l.id, l]));

/** Listings to render rows for: every active listing, plus any inactive listing
 * the attendee already books (so an existing inactive registration still shows
 * its quantity and can be edited). Active first, then inactive-booked. */
const getRenderListings = async (
  existing: ExistingLine[],
): Promise<ListingWithCount[]> => {
  const all = await getAllListings();
  const active = filter((l: ListingWithCount) => l.active)(all);
  const bookedIds = new Set(existing.map((e) => e.booking.listing_id));
  const inactiveBooked = filter(
    (l: ListingWithCount) => !l.active && bookedIds.has(l.id),
  )(all);
  return [...active, ...inactiveBooked];
};

/** First (earliest) existing booking per listing. A legacy attendee with two
 * bookings of the same listing binds the row to the earliest; the rest fall out
 * of the desired set on save, normalising onto the one shared range. */
const firstExistingByListingId = (
  existing: ExistingLine[],
): Map<number, ExistingLine> => {
  const map = new Map<number, ExistingLine>();
  for (const e of existing) {
    if (!map.has(e.booking.listing_id)) map.set(e.booking.listing_id, e);
  }
  return map;
};

/** Build one editor line per rendered listing: the existing booking's quantity
 * and key when present, otherwise the pre-selected quantity (0 = not booked). */
const buildFormLines = (
  renderListings: ListingWithCount[],
  existingByListingId: Map<number, ExistingLine>,
  preselectedQty: Map<number, number>,
): AttendeeFormLine[] =>
  renderListings.map((listing) => {
    const existing = existingByListingId.get(listing.id);
    return {
      error: null,
      existingBooking: existing?.booking ?? null,
      key: existing?.key ?? "",
      listing,
      listingId: listing.id,
      quantity: existing
        ? existing.booking.quantity
        : (preselectedQty.get(listing.id) ?? 0),
    };
  });

/** Build a create-mode form: a line per active listing (quantity from any
 * pre-selection) and the shared start date from the deep link. */
const buildCreateForm = (
  renderListings: ListingWithCount[],
  preselectedQty: Map<number, number>,
  startDate: string,
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  emailAdminNotes: "",
  lines: buildFormLines(renderListings, new Map(), preselectedQty),
  name: "",
  phone: "",
  phoneAdminNotes: "",
  remainingBalance: 0,
  returnUrl: "",
  special_instructions: "",
  startDate,
  statusId: null,
});

/** Build the edit-mode form from a loaded attendee + its bookings, seeding the
 * shared range from the existing daily bookings. */
const buildEditFormFromAttendee = (
  attendee: Attendee,
  existing: ExistingLine[],
  renderListings: ListingWithCount[],
): { parsed: ParsedAttendeeForm; hasMixedTimings: boolean } => {
  const shared = resolveSharedDates(existing.map((e) => e.booking));
  return {
    hasMixedTimings: shared.hasMixedTimings,
    parsed: {
      address: attendee.address || "",
      dayCount: shared.dayCount,
      email: attendee.email || "",
      emailAdminNotes: "",
      lines: buildFormLines(
        renderListings,
        firstExistingByListingId(existing),
        new Map(),
      ),
      name: attendee.name,
      phone: attendee.phone || "",
      phoneAdminNotes: "",
      remainingBalance: attendee.remaining_balance,
      returnUrl: "",
      special_instructions: attendee.special_instructions || "",
      startDate: shared.startDate,
      statusId: attendee.status_id,
    },
  };
};

/** How many of an attendee's activity-log entries to show on the edit page. */
const ATTENDEE_LOG_LIMIT = 1000;

/** A booked daily listing booked for longer than its own duration allows —
 * permitted (every daily listing shares one range), so a warning not an error. */
const overDurationWarning = (
  line: AttendeeFormLine,
  dayCount: number,
): string | null => {
  const listing = line.listing!;
  if (listing.listing_type !== "daily" || dayCount <= listing.duration_days) {
    return null;
  }
  const max = listing.duration_days;
  return `${listing.name} is designed for up to ${max} day${
    max === 1 ? "" : "s"
  }, but the booking spans ${dayCount}.`;
};

/** The capacity-check booking shape for a booked line on the shared range
 * (daily) or no date (standard). */
const lineBookingFor = (line: AttendeeFormLine, parsed: ParsedAttendeeForm) => {
  const isDaily = line.listing!.listing_type === "daily";
  return {
    date: isDaily ? parsed.startDate : null,
    durationDays: isDaily ? parsed.dayCount : 1,
    listingId: line.listingId,
    quantity: line.quantity!,
  };
};

/** The set of booked listing ids that overbook capacity, judged with one
 * batched self-excluding check (the same one the save uses). A daily line with
 * no valid shared date is skipped — the date error already blocks saving. */
const overbookedListingIds = async (
  booked: AttendeeFormLine[],
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<Set<number>> => {
  const checkable = booked.filter(
    (line) =>
      line.listing!.listing_type !== "daily" || isIsoDate(parsed.startDate),
  );
  const fits = await checkLinesCapacity(
    checkable.map((line) => lineBookingFor(line, parsed)),
    excludeAttendeeId,
  );
  const overbooked = new Set<number>();
  checkable.forEach((line, i) => {
    if (!fits[i]) overbooked.add(line.listingId);
  });
  return overbooked;
};

/** Overbooking message for a booked line. */
const overbookMessage = (line: AttendeeFormLine): string =>
  `${
    line.listing!.name
  } is overbooked — there isn't capacity for ${line.quantity} on these dates.`;

/**
 * Over-duration + overbooking warnings for every booked line, keyed by listing
 * id plus a flat list for the top-of-page summary. Both are allowed for admin
 * saves, so they surface as warnings, not errors. The capacity side is one
 * batched query for the whole form, not one per line.
 */
const computeWarnings = async (
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<{ byListing: Map<number, string[]>; top: string[] }> => {
  const booked = parsed.lines.filter(isBookedLine);
  const overbooked = await overbookedListingIds(
    booked,
    parsed,
    excludeAttendeeId,
  );
  const byListing = new Map<number, string[]>();
  const top: string[] = [];
  for (const line of booked) {
    const warns = compact([
      overDurationWarning(line, parsed.dayCount),
      overbooked.has(line.listingId) ? overbookMessage(line) : null,
    ]);
    if (warns.length > 0) {
      byListing.set(line.listingId, warns);
      top.push(...warns);
    }
  }
  return { byListing, top };
};

/** Build the template data for re-rendering the form. */
const buildTemplateData = async (
  mode: "create" | "edit",
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
  opts: {
    attendeeError?: string | null;
    dateError?: string | null;
    flashError?: string;
    flashSuccess?: string;
    hasMixedTimings?: boolean;
    returnUrl?: string;
    questions?: QuestionWithAnswers[];
    selectedAnswerIds?: number[];
    contactStats?: ContactStatsByChannel;
  } = {},
): Promise<AttendeeFormTemplateData> => {
  const statuses = await getAllAttendeeStatuses();
  // The order totals come from the saved booking (edit only); create has none.
  const summary = attendee ? await getAttendeeOrderSummary(attendee.id) : null;
  const balanceNotice = attendeeBalanceNotice(
    statuses.find((s) => s.id === parsed.statusId) ?? null,
    parsed.remainingBalance,
    summary?.fullPrice ?? 0,
    summary?.depositPaid ?? 0,
    summary?.listedFullPrice ?? 0,
  );
  const activityLog = attendee
    ? await getAttendeeActivityLog(attendee.id, ATTENDEE_LOG_LIMIT)
    : [];
  const warnings = await computeWarnings(parsed, attendee?.id);
  const logistics = await buildAttendeeLogisticsData(parsed.lines, attendee);
  return {
    activityLog,
    allowedDomain: getEffectiveDomain(),
    attendee,
    attendeeError: opts.attendeeError ?? null,
    balanceNotice,
    contactStats: opts.contactStats ?? EMPTY_CONTACT_STATS_BY_CHANNEL,
    dateError: opts.dateError ?? null,
    flashError: opts.flashError,
    flashSuccess: opts.flashSuccess,
    // The shared date range only affects daily listings; the form's rendered
    // lines cover every active listing plus any inactive one this attendee
    // already books, so a daily line here is exactly when the dates matter.
    hasDailyListings: parsed.lines.some(
      (l) => l.listing?.listing_type === "daily",
    ),
    hasMixedTimings: opts.hasMixedTimings ?? false,
    lineWarnings: warnings.byListing,
    logistics,
    mode,
    parsed,
    phonePrefix: settings.phonePrefix,
    questions: opts.questions ?? [],
    returnUrl: opts.returnUrl,
    selectedAnswerIds: opts.selectedAnswerIds ?? [],
    statuses,
    todayIso: todayInTz(settings.timezone),
    topWarnings: warnings.top,
  };
};

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's booked listings (edit mode only). */
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

/** Render a GET of the form, surfacing any post-save flash (cookie). */
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
// GET handlers
// ---------------------------------------------------------------------------

/** Handle GET /admin/attendees/new — render the create form, pre-filled from a
 * calendar deep link when present. */
export const handleAttendeeNewGet: TypedRouteHandler<
  "GET /admin/attendees/new"
> = (request) =>
  requireSessionOr(request, async (session) => {
    const renderListings = await getRenderListings([]);
    const params = new URL(request.url).searchParams;
    const preselectedQty = new Map(
      parseSelectedListingIds(params).map((id) => [id, 1]),
    );
    const startParam = params.get(START_DATE_FIELD) ?? "";
    const parsed = buildCreateForm(
      renderListings,
      preselectedQty,
      isIsoDate(startParam) ? startParam : "",
    );
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
    const renderListings = await getRenderListings(loaded.existing);
    const { parsed, hasMixedTimings } = buildEditFormFromAttendee(
      loaded.attendee,
      loaded.existing,
      renderListings,
    );
    const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
      attendeeId,
      loaded.existing,
    );
    const contactStats = await loadContactStats(session, loaded.attendee);
    parsed.emailAdminNotes = contactStats.email?.adminNotes ?? "";
    parsed.phoneAdminNotes = contactStats.phone?.adminNotes ?? "";
    const data = await buildTemplateData("edit", parsed, loaded.attendee, {
      contactStats,
      hasMixedTimings,
      questions,
      returnUrl: getSearchParam(request, "return_url"),
      selectedAnswerIds,
    });
    return renderAttendeeFormPage(request, data, session);
  });

/** Read the attendee's bulk-email contact history (null when no email). */
const loadContactStats = async (
  session: AuthSession,
  attendee: Attendee,
): Promise<ContactStatsByChannel> => {
  const pk = await requirePrivateKey(session);
  return {
    email: attendee.email
      ? await getContactStats(await hashEmail(attendee.email), pk)
      : null,
    phone: attendee.phone
      ? await getContactStats(await hashPhone(attendee.phone), pk)
      : null,
  };
};

type ContactHashesByChannel = { email: string | null; phone: string | null };
type ContactStatsByChannel = {
  email: ContactStats | null;
  phone: ContactStats | null;
};

const EMPTY_CONTACT_STATS_BY_CHANNEL: ContactStatsByChannel = {
  email: null,
  phone: null,
};

const contactHashesFor = async (
  email: string,
  phone: string,
): Promise<ContactHashesByChannel> => ({
  email: email.trim() ? await hashEmail(email) : null,
  phone: phone.trim() ? await hashPhone(phone) : null,
});

const compactContactHashes = (hashes: ContactHashesByChannel): string[] =>
  [hashes.email, hashes.phone].filter((hash): hash is string => Boolean(hash));

const saveContactPreferenceBlob = async (
  parsed: ParsedAttendeeForm,
  privateKey: CryptoKey,
  options: { recordBooking: boolean },
): Promise<void> => {
  const hashes = await contactHashesFor(parsed.email, parsed.phone);
  if (options.recordBooking) {
    await recordBookingStats(compactContactHashes(hashes), false, privateKey);
  }
  if (hashes.email) {
    await saveContactAdminNotes(
      hashes.email,
      parsed.emailAdminNotes,
      privateKey,
    );
  }
  if (hashes.phone) {
    await saveContactAdminNotes(
      hashes.phone,
      parsed.phoneAdminNotes,
      privateKey,
    );
  }
};

/** Load an attendee + all its listing_attendees rows for the edit page. */
const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{ attendee: Attendee; existing: ExistingLine[] } | null> => {
  const pk = await requirePrivateKey(session);
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
      ? await loadEditContext(session, attendeeId)
      : EMPTY_EDIT_CONTEXT;
  if (edit === null) return notFoundResponse();
  const { attendee, existingByKey, questions, selectedAnswerIds } = edit;

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
  };

  const result = validateParsedForm(parsed);
  const dataForRerender = await buildTemplateData(
    mode,
    result.values,
    attendee,
    renderOpts,
  );
  if (!result.valid) {
    return renderForm(session, {
      ...dataForRerender,
      attendeeError: result.attendeeError?.message ?? null,
      dateError: result.dateError,
    });
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
      ? await applyCreate(parsed, logisticsPlan, session)
      : await applyEdit(
          attendeeId!,
          parsed,
          attendee!,
          questions,
          parseQuestionAnswers({ optional: true })(form, questions).answerIds,
          logisticsPlan,
          session,
        );
  if (outcome.ok) return outcome.response;
  return renderForm(session, {
    ...dataForRerender,
    flashError: outcome.flashError,
  });
};

/** Outcome of an atomic create/edit attempt. */
type SaveOutcome =
  | { ok: true; response: Response }
  | { ok: false; flashError: string };

/** Shown when a submission has no booked listing. */
const NO_LINES_ERROR = "Book at least one listing before saving";

/** Shown when capacity can't fit the submitted lines. */
const CAPACITY_SAVE_ERROR =
  "Not enough spots available for one or more selected listings — nothing was saved. Please review the quantities and try again.";

/** The edit page for an attendee, carrying the return_url through. */
const attendeePath = (id: number, returnUrl: string): string =>
  returnUrl
    ? `/admin/attendees/${id}?return_url=${encodeURIComponent(returnUrl)}`
    : `/admin/attendees/${id}`;

/** Redirect back to the saved attendee's own form, scrolling to it. */
const savedRedirect = (
  id: number,
  returnUrl: string,
  message: string,
): Response =>
  redirect(`${attendeePath(id, returnUrl)}#${ATTENDEE_FORM_ID}`, message, true);

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
  session: AuthSession,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { flashError: NO_LINES_ERROR, ok: false };
  }
  // Admin manual add may deliberately overbook (a warning is shown, not blocked).
  const createResult = await createAttendeeAtomic({
    ...input,
    allowOverbook: true,
  });
  const check = await ensureAllBookings(createResult, input.bookings.length);
  if (!check.ok) {
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
  }
  const { attendees } = createResult as Extract<
    CreateAttendeeResult,
    { success: true }
  >;
  const firstListingId = input.bookings[0]!.listingId;
  const newId = attendees[0]!.id;
  await saveContactPreferenceBlob(parsed, await requirePrivateKey(session), {
    recordBooking: true,
  });
  await applyLogisticsPlan(newId, logisticsPlan);
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
  logisticsPlan: LogisticsPlan,
  session: AuthSession,
): Promise<SaveOutcome> => {
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
      return { flashError: NO_LINES_ERROR, ok: false };
    }
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
  }

  await updateAttendeeOrder(
    attendeeId,
    parsed.statusId,
    parsed.remainingBalance,
  );

  await saveContactPreferenceBlob(parsed, await requirePrivateKey(session), {
    recordBooking: false,
  });

  await applyLogisticsPlan(attendeeId, logisticsPlan);

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
