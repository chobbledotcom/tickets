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
  attendeeBookingsFromLines,
  isBookedLine,
  isNoQuantityLine,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  resolveSharedDates,
  resolveStatusId,
  toCreateInput,
  toDesiredLines,
  toLedgerOrder,
  validateParsedForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  buildAttendeeLogisticsData,
  parseLogisticsPlan,
} from "#routes/admin/attendee-logistics.ts";
import { loadLedgerNames } from "#routes/admin/ledger.ts";
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
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { manualAddLedgerPoster } from "#shared/checkout-complete.ts";
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
  hasPaidLine,
  type ListingAttendeeRow,
  loadExistingLines,
  updateAttendeeOrder,
} from "#shared/db/attendees.ts";
import { hasAssignedBuiltSite } from "#shared/db/built-sites.ts";
import {
  getContactRecord,
  getRepairFallbackRecord,
  hashEmail,
  hashPhone,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import {
  getAttendeeTextAnswers,
  loadAttendeeQuestionData,
  parseQuestionAnswers,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { statementFor } from "#shared/ledger/project.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  parseSelectedListingIds,
  START_DATE_FIELD,
} from "#shared/order-select.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import type { AttendeeLedgerData } from "#templates/admin/attendee-detail.tsx";
import {
  type AttendeeFormTemplateData,
  attendeeFormPage,
  type ContactChannelData,
  type ContactRecordsByChannel,
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
    const quantity = existing
      ? existing.booking.quantity
      : (preselectedQty.get(listing.id) ?? 0);
    return {
      error: null,
      existingBooking: existing?.booking ?? null,
      key: existing?.key ?? "",
      listing,
      listingId: listing.id,
      // A stored quantity-0 line renders with the "no quantity" box ticked.
      noQuantity: Boolean(existing) && quantity === 0,
      quantity,
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
  lines: buildFormLines(renderListings, new Map(), preselectedQty),
  name: "",
  phone: "",
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
      lines: buildFormLines(
        renderListings,
        firstExistingByListingId(existing),
        new Map(),
      ),
      name: attendee.name,
      phone: attendee.phone || "",
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

/** Load the attendee's ledger account statement for the embedded panel: its full
 * transfer history, the running-balance lines, and the counterparties' display
 * names (the shared ledger loader, so names resolve exactly as /admin/ledger). */
const loadAttendeeLedger = async (
  attendeeId: number,
): Promise<AttendeeLedgerData> => {
  const account = attendeeAccount(attendeeId);
  const transfers = await transfersByAccount(account);
  return {
    account,
    lines: statementFor(account)(transfers),
    names: await loadLedgerNames(transfers),
  };
};

/** The ledger panel exposes money movements (payment/refund/writeoff legs), so
 * it is owner-only — matching the standalone `/admin/ledger*` routes
 * (`requireOwnerOr`). A non-owner staff session gets `undefined`, which the
 * template renders as no panel at all. */
const loadAttendeeLedgerForSession = (
  session: AuthSession,
  attendeeId: number,
): Promise<AttendeeLedgerData | undefined> =>
  session.adminLevel === "owner"
    ? loadAttendeeLedger(attendeeId)
    : Promise.resolve(undefined);

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
    selectedTextAnswers?: Map<number, string>;
    contactRecords?: ContactRecordsByChannel;
    ledger?: AttendeeLedgerData;
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
    bookings: attendeeBookingsFromLines(parsed.lines),
    contactRecords: opts.contactRecords ?? EMPTY_CONTACT_RECORDS,
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
    ledger: opts.ledger,
    lineWarnings: warnings.byListing,
    logistics,
    mode,
    parsed,
    phonePrefix: settings.phonePrefix,
    questions: opts.questions ?? [],
    returnUrl: opts.returnUrl,
    selectedAnswerIds: opts.selectedAnswerIds ?? [],
    selectedTextAnswers: opts.selectedTextAnswers ?? new Map(),
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
  privateKey: CryptoKey,
): Promise<{
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  selectedTextAnswers: Map<number, string>;
}> => {
  const listingIds = unique(existing.map((e) => e.booking.listing_id));
  const data = await loadAttendeeQuestionData(listingIds, [attendeeId]);
  if (!data) {
    return {
      questions: [],
      selectedAnswerIds: [],
      selectedTextAnswers: new Map(),
    };
  }
  return {
    questions: data.questions,
    selectedAnswerIds: data.attendeeAnswerMap.get(attendeeId) ?? [],
    selectedTextAnswers: await getAttendeeTextAnswers(attendeeId, privateKey),
  };
};

/** Resolve the session's private key and load the attendee's question context
 * with it — the two always pair up at the edit-form call sites. */
const loadQuestionsForSession = async (
  session: AuthSession,
  attendeeId: number,
  existing: ExistingLine[],
) => {
  const privateKey = await requirePrivateKey(session);
  return loadQuestionsForExisting(attendeeId, existing, privateKey);
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
    const { questions, selectedAnswerIds, selectedTextAnswers } =
      await loadQuestionsForSession(session, attendeeId, loaded.existing);
    const contactRecords = await loadContactRecords(session, loaded.attendee);
    const ledger = await loadAttendeeLedgerForSession(session, attendeeId);
    const data = await buildTemplateData("edit", parsed, loaded.attendee, {
      contactRecords,
      hasMixedTimings,
      ledger,
      questions,
      returnUrl: getSearchParam(request, "return_url"),
      selectedAnswerIds,
      selectedTextAnswers,
    });
    return renderAttendeeFormPage(request, data, session);
  });

const EMPTY_CONTACT_RECORDS: ContactRecordsByChannel = {
  email: null,
  phone: null,
};

/** Load and decrypt one channel's contact record (null when no value on file).
 * Notes are owner-encrypted, so this needs the session private key. */
const loadChannelRecord = async (
  value: string,
  hashOf: (value: string) => Promise<string>,
  privateKey: CryptoKey,
): Promise<ContactChannelData | null> => {
  if (!value.trim()) return null;
  const hash = await hashOf(value);
  try {
    return {
      hashParam: toContactHashParam(hash),
      record: await getContactRecord(hash, privateKey),
    };
  } catch (error) {
    // A corrupt/undecryptable stats_blob for one contact must not take down
    // the whole attendee edit page. Surface it for repair and keep the channel
    // with its surviving counts and (crucially) its /admin/history link, so the
    // operator can still open the editor and overwrite the bad row — dropping
    // the channel here would hide the only path to fix it.
    logError({
      code: ErrorCode.DECRYPT_FAILED,
      detail: `contact history ${toContactHashParam(hash)}: ${error}`,
    });
    return {
      hashParam: toContactHashParam(hash),
      record: await getRepairFallbackRecord(hash),
    };
  }
};

/** Read the attendee's per-channel contact history for the read-only panel.
 * The private key is only needed (and only requested) when there is at least
 * one contact value to decrypt, so an attendee with no email/phone never forces
 * a key prompt. */
const loadContactRecords = async (
  session: AuthSession,
  attendee: Attendee,
): Promise<ContactRecordsByChannel> => {
  if (!attendee.email.trim() && !attendee.phone.trim()) {
    return EMPTY_CONTACT_RECORDS;
  }
  const pk = await requirePrivateKey(session);
  return {
    email: await loadChannelRecord(attendee.email, hashEmail, pk),
    phone: await loadChannelRecord(attendee.phone, hashPhone, pk),
  };
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
  session: AuthSession,
  attendeeId: number,
): Promise<EditContext | null> => {
  const loaded = await loadAttendeeForEdit(session, attendeeId);
  if (!loaded) return null;
  const { questions, selectedAnswerIds, selectedTextAnswers } =
    await loadQuestionsForSession(session, attendeeId, loaded.existing);
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
    // Edit re-renders keep the embedded ledger panel (owner-only); create has no
    // account yet.
    ledger: attendee
      ? await loadAttendeeLedgerForSession(session, attendee.id)
      : undefined,
    questions,
    returnUrl: parsed.returnUrl,
    selectedAnswerIds,
    selectedTextAnswers,
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

/** Shown when a no-quantity tick targets a line that still holds a built site. */
const BUILT_SITE_NO_QTY_ERROR =
  "Unassign the built site from this booking before marking it no quantity.";

/** Shown when a no-quantity tick targets a line that still has a recorded payment. */
const PAID_NO_QTY_ERROR =
  "Refund this booking's payment before marking it no quantity.";

/**
 * True when any no-quantity line satisfies a per-(attendee, listing) check,
 * judged from the live DB (not the form's submitted key). Used by applyEdit to
 * block marking a line no-quantity while it still holds an assigned built site
 * (the assignment + public /renew/ path would survive behind a hidden line) or a
 * recorded payment (a stale form key would otherwise hide the booking from the
 * per-line model guard and let the atomic edit drop the paid row).
 */
const anyNoQuantityLineMatches = async (
  attendeeId: number,
  lines: AttendeeFormLine[],
  check: (attendeeId: number, listingId: number) => Promise<boolean>,
): Promise<boolean> => {
  for (const line of lines) {
    if (isNoQuantityLine(line) && (await check(attendeeId, line.listingId))) {
      return true;
    }
  }
  return false;
};

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
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { flashError: NO_LINES_ERROR, ok: false };
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
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
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
    response: savedRedirect(newId, parsed.returnUrl, `Added ${parsed.name}`),
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
    return { flashError: BUILT_SITE_NO_QTY_ERROR, ok: false };
  }
  // Block marking a paid line no-quantity, even when a stale form key hid the
  // existing booking from the per-line model guard.
  if (await anyNoQuantityLineMatches(attendeeId, parsed.lines, hasPaidLine)) {
    return { flashError: PAID_NO_QTY_ERROR, ok: false };
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
      return { flashError: NO_LINES_ERROR, ok: false };
    }
    return { flashError: CAPACITY_SAVE_ERROR, ok: false };
  }

  // When the save leaves no real (quantity > 0) line the public pay gate refuses
  // payment, so reconcile the ledger balance to 0 rather than strand an unpayable
  // receivable on a ghost; otherwise reconcile to the entered balance. The
  // reconcile posts a writeoff leg, which is itself the audit record of the clear.
  const hasRealLine = desired.some((l) => l.quantity > 0);
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
