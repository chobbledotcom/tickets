/**
 * Routes for the unified add/edit attendee page.
 *
 *   GET  /admin/attendees/new      — render empty form (create mode)
 *   POST /admin/attendees/new      — handle create submission
 *   GET  /admin/attendees/:id      — render form preloaded with attendee (edit mode)
 *   POST /admin/attendees/:id      — handle edit submission
 *
 * Create and edit share every step:
 *   1. Load available events + (edit only) current attendee/lines.
 *   2. Parse the form into attendee + line items.
 *   3. If the operator clicked add-line / remove-line, re-render without
 *      saving (preserve all entered data).
 *   4. Otherwise validate. On failure, re-render with line-level errors.
 *   5. Run the atomic create or update.
 *   6. Redirect with a success/failure flash.
 */

import { compact, filter, map, pipe, unique, uniqueBy } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import {
  applyAttendeeAtomicEdit,
  buildPiiBlob,
  type CreateAttendeeResult,
  createAttendeeAtomic,
  encryptPiiBlob,
  ensureAllBookings,
  getAttendee,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsWithEventIds,
  type QuestionWithAnswers,
  readQuestionAnswer,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { settings } from "#shared/db/settings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Attendee, EventWithCount, Holiday } from "#shared/types.ts";
import {
  defaultNewDailyDate,
  type AttendeeFormLine,
  type DailyDefaults,
  type ParsedAttendeeForm,
  resolveDailyDefaults,
  toCreateInput,
  toDesiredLines,
  trimTrailingBlankLines,
  validateParsedForm,
  parseAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  attendeeFormPage,
  type AttendeeFormTemplateData,
} from "#templates/admin/attendee-form.tsx";

// ---------------------------------------------------------------------------
// Shared loaders / helpers
// ---------------------------------------------------------------------------

/** Events selectable in the dropdown: active events plus any currently
 * selected events (so an inactive selected event still renders its name). */
const getEventsForSelector = async (
  parsed: ParsedAttendeeForm | null,
): Promise<EventWithCount[]> => {
  const allEvents = await getAllEvents();
  const active = filter((e: EventWithCount) => e.active)(allEvents);
  if (!parsed) return active;
  const selectedIds = new Set(
    pipe(
      map((line: AttendeeFormLine) => line.eventId),
      filter((id: number) => id > 0),
    )(parsed.lines),
  );
  const selectedInactive = filter(
    (e: EventWithCount) => selectedIds.has(e.id) && !e.active,
  )(allEvents);
  return uniqueBy((e: EventWithCount) => e.id)(
    compact([...selectedInactive, ...active]),
  );
};

/** Index events by id for line resolution. */
const eventsByIdMap = (
  events: EventWithCount[],
): Map<number, EventWithCount> => new Map(events.map((e) => [e.id, e]));

/** Build the available-dates map for every daily event in the selector. */
const buildAvailableDates = (
  events: EventWithCount[],
  holidays: Holiday[],
): Promise<Record<number, string[]>> => {
  const result: Record<number, string[]> = {};
  for (const event of events) {
    if (event.event_type === "daily") {
      result[event.id] = getAvailableDates(event, holidays);
    }
  }
  return Promise.resolve(result);
};

/** A fresh, empty event line. The daily date defaults to the attendee's
 * shared start date when the existing daily lines are uniform, otherwise to
 * tomorrow — so a daily row never starts with an empty date. */
const emptyLine = (
  todayIso: string,
  inheritedDate: string | null,
): AttendeeFormLine => ({
  date: inheritedDate ?? defaultNewDailyDate(todayIso),
  error: null,
  event: null,
  eventId: 0,
  existingBooking: null,
  key: "",
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
  returnUrl: "",
  special_instructions: "",
});

/** Build the edit-mode form shell from a loaded attendee + its bookings. */
const buildEditFormFromAttendee = (
  attendee: Attendee,
  existing: { key: string; booking: import("#shared/db/attendee-types.ts").EventAttendeeRow }[],
  eventsById: Map<number, EventWithCount>,
): ParsedAttendeeForm => {
  const lines: AttendeeFormLine[] = existing.map(({ key, booking }) => {
    const event = eventsById.get(booking.event_id) ?? null;
    return {
      date: booking.start_at?.slice(0, 10) ?? "",
      error: null,
      event,
      eventId: booking.event_id,
      existingBooking: booking,
      key,
      quantity: booking.quantity,
    };
  });
  // Always append one blank line so the operator has somewhere to type a new
  // registration without clicking "Add Event Line" first. It inherits the
  // attendee's shared daily date when the existing daily lines are uniform.
  lines.push(
    emptyLine(todayInTz(settings.timezone), resolveDailyDefaults(lines).inheritedDate),
  );
  return {
    action: { kind: "save" },
    address: attendee.address || "",
    email: attendee.email || "",
    lines,
    name: attendee.name,
    phone: attendee.phone || "",
    returnUrl: "",
    special_instructions: attendee.special_instructions || "",
  };
};

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
  } = {},
): Promise<AttendeeFormTemplateData> => {
  const allEvents = await getEventsForSelector(parsed);
  const holidays = await getActiveHolidays();
  const availableDatesByEvent = await buildAvailableDates(allEvents, holidays);
  const dailyDefaults: DailyDefaults = resolveDailyDefaults(parsed.lines);
  return {
    allEvents,
    attendee,
    attendeeError: opts.attendeeError ?? null,
    availableDatesByEvent,
    dailyDefaults,
    flashError: opts.flashError,
    flashSuccess: opts.flashSuccess,
    mode,
    parsed,
    questions: opts.questions,
    returnUrl: opts.returnUrl,
    selectedAnswerIds: opts.selectedAnswerIds ?? [],
    todayIso: todayInTz(settings.timezone),
  };
};

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's events (edit mode only). Rendering and saving every event's
 * questions — not just the first — is what keeps the save from wiping answers
 * tied to the attendee's other events: answers are stored per attendee, so the
 * submitted set must cover every question the attendee can have answered. */
const loadAttendeeQuestions = async (
  attendeeId: number,
  eventIds: number[],
): Promise<{
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
}> => {
  if (eventIds.length === 0) return { questions: [], selectedAnswerIds: [] };
  const [{ questions }, answersMap] = await Promise.all([
    getQuestionsWithEventIds(eventIds),
    getAttendeeAnswersBatch([attendeeId]),
  ]);
  return {
    questions,
    selectedAnswerIds: answersMap.get(attendeeId) ?? [],
  };
};

/** Read return_url from request query params. */
const readReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Apply the flash cookie and render the attendee form page. */
const renderAttendeeFormPage = (
  request: Request,
  data: AttendeeFormTemplateData,
  session: AuthSession,
): Response => {
  const flash = applyFlash(request);
  return htmlResponse(
    attendeeFormPage(
      { ...data, flashError: flash.error, flashSuccess: flash.success },
      session,
    ),
  );
};

/** Load custom questions for an attendee across every event it is booked on. */
const loadQuestionsForExisting = (
  attendeeId: number,
  existing: { booking: { event_id: number } }[],
): Promise<{ questions: QuestionWithAnswers[]; selectedAnswerIds: number[] }> =>
  loadAttendeeQuestions(
    attendeeId,
    unique(existing.map((e) => e.booking.event_id)),
  );

// ---------------------------------------------------------------------------
// GET /admin/attendees/new  (and GET /admin/attendees/:id)
// ---------------------------------------------------------------------------

/** Handle GET /admin/attendees/new — render the empty create form. */
export const handleAttendeeNewGet: TypedRouteHandler<"GET /admin/attendees/new"> =
  (request) =>
    requireSessionOr(request, async (session) => {
      const parsed = buildEmptyCreateForm();
      const data = await buildTemplateData("create", parsed, null, {
        returnUrl: readReturnUrl(request),
      });
      return renderAttendeeFormPage(request, data, session);
    });

/** Handle GET /admin/attendees/:id — render the edit form preloaded. */
export const handleAttendeeEditGet: TypedRouteHandler<"GET /admin/attendees/:attendeeId"> =
  (request, { attendeeId }) =>
    requireSessionOr(request, async (session) => {
      const loaded = await loadAttendeeForEdit(session, attendeeId);
      if (!loaded) return notFoundResponse();
      const allEvents = await getEventsForSelector(null);
      const eventsById = eventsByIdMap(allEvents);
      const parsed = buildEditFormFromAttendee(
        loaded.attendee,
        loaded.existing,
        eventsById,
      );
      const { questions, selectedAnswerIds } = await loadQuestionsForExisting(
        attendeeId,
        loaded.existing,
      );
      const data = await buildTemplateData("edit", parsed, loaded.attendee, {
        questions,
        returnUrl: readReturnUrl(request),
        selectedAnswerIds,
      });
      return renderAttendeeFormPage(request, data, session);
    });

/** Load an attendee + all its event_attendees rows for the edit page. */
const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{
  attendee: Attendee;
  existing: { key: string; booking: import("#shared/db/attendee-types.ts").EventAttendeeRow }[];
} | null> => {
  const pk = await requirePrivateKey(session);
  // PII-only load; the per-event lines come from loadExistingLines, so no join.
  const attendee = await getAttendee(attendeeId, pk);
  if (!attendee) return null;
  const existing = await loadExistingLines(attendeeId);
  return { attendee, existing };
};

// ---------------------------------------------------------------------------
// POST handlers — shared submit logic
// ---------------------------------------------------------------------------

/** Apply add-line / remove-line transformations to a parsed form.
 *
 * Both actions are pure form-state edits — nothing is written to the
 * database. Removing an existing line just drops it from the form; the actual
 * `event_attendees` delete happens when the operator saves (the atomic update
 * diffs it out). That keeps removal part of the one logical "save the whole
 * attendee" submission, so other typed-in changes are never lost to a
 * mid-edit redirect. A newly added line inherits the attendee's shared daily
 * start date when the existing daily lines are uniform.
 *
 * Returns `{ kind: "save" }` when the action was a plain save. */
const applyLineAction = (
  parsed: ParsedAttendeeForm,
  todayIso: string,
):
  | { kind: "rerender"; parsed: ParsedAttendeeForm }
  | { kind: "save" } => {
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
 * mode. */
const handleSubmit = (
  mode: "create" | "edit",
  attendeeId: number | null,
) =>
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

  // Load attendee (edit mode) + build events index for line resolution.
  let attendee: Attendee | null = null;
  const existingByKey = new Map<string, import("#shared/db/attendee-types.ts").EventAttendeeRow>();
  let questions: QuestionWithAnswers[] = [];
  let selectedAnswerIds: number[] = [];
  if (mode === "edit" && attendeeId !== null) {
    const loaded = await loadAttendeeForEdit(session, attendeeId);
    if (!loaded) return notFoundResponse();
    attendee = loaded.attendee;
    for (const { key, booking } of loaded.existing) {
      existingByKey.set(key, booking);
    }
    const ctx = await loadQuestionsForExisting(attendeeId, loaded.existing);
    questions = ctx.questions;
    selectedAnswerIds = ctx.selectedAnswerIds;
  }

  const allEvents = await getAllEvents();
  const eventsById = eventsByIdMap(allEvents);
  const parsed = parseAttendeeForm(form, eventsById, existingByKey);

  // Step 1: line-action re-render (no save).
  const todayIso = todayInTz(settings.timezone);
  const lineAction = applyLineAction(parsed, todayIso);
  if (lineAction.kind === "rerender") {
    const data = await buildTemplateData(mode, lineAction.parsed, attendee, {
      questions,
      returnUrl: parsed.returnUrl,
      selectedAnswerIds,
    });
    return htmlResponse(attendeeFormPage(data, session));
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
    { questions, returnUrl: parsed.returnUrl, selectedAnswerIds },
  );
  if (!result.valid) {
    const attendeeError = result.attendeeError?.message ?? null;
    return htmlResponse(
      attendeeFormPage(
        { ...dataForRerender, attendeeError },
        session,
      ),
    );
  }

  // Step 4: apply atomic create or edit. On a recoverable failure (capacity,
  // encryption, no lines) re-render the submitted form in place so the
  // operator never loses entered data, marking the failing line where known.
  const outcome = mode === "create"
    ? await applyCreate(parsed)
    : await applyEdit(
      attendeeId!,
      parsed,
      attendee!,
      questions,
      parseQuestionAnswers(form, questions),
    );
  if (outcome.ok) return outcome.response;
  return htmlResponse(
    attendeeFormPage(
      { ...dataForRerender, flashError: outcome.flashError },
      session,
    ),
  );
};

/** Outcome of an atomic create/edit attempt. A recoverable failure carries
 * the flash to show; the submit handler re-renders the submitted form in
 * place so no entered data is lost. */
type SaveOutcome =
  | { ok: true; response: Response }
  | { ok: false; flashError: string };

/** Read submitted question answers from the form, filtered to valid options. */
const parseQuestionAnswers = (
  form: FormParams,
  questions: QuestionWithAnswers[],
): number[] => {
  const answerIds: number[] = [];
  for (const q of questions) {
    // Admin edit treats answers as optional — keep only the valid ones.
    const answer = readQuestionAnswer(form, q);
    if (answer.status === "ok") answerIds.push(answer.answerId);
  }
  return answerIds;
};

/** Run the atomic create flow. All-or-nothing: `ensureAllBookings` rolls the
 * attendee back unless every submitted line fits, so a partial booking never
 * shows a misleading success. */
const applyCreate = async (
  parsed: ParsedAttendeeForm,
): Promise<SaveOutcome> => {
  const input = toCreateInput(parsed);
  if (input.bookings.length === 0) {
    return { flashError: "Add at least one event line before saving", ok: false };
  }
  const createResult = await createAttendeeAtomic(input);
  const check = await ensureAllBookings(createResult, input.bookings.length);
  if (!check.ok) {
    return {
      flashError:
        "Not enough spots available for one or more selected events — nothing was saved",
      ok: false,
    };
  }
  // ensureAllBookings guarantees full success past the ok check.
  const { attendees } = createResult as Extract<
    CreateAttendeeResult,
    { success: true }
  >;

  const firstEventId = parsed.lines.find((line) => line.eventId > 0)!.eventId;
  await logActivity(`Attendee '${parsed.name}' added manually`, firstEventId);

  const target = parsed.returnUrl || `/admin/attendees/${attendees[0]!.id}`;
  return { ok: true, response: redirect(target, `Added ${parsed.name}`, true) };
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
      return { flashError: "Add at least one event line before saving", ok: false };
    }
    return {
      flashError:
        "Not enough spots remain for one of the selected events — nothing was saved. Please review your event lines and try again.",
      ok: false,
    };
  }

  // Save question answers (atomic delete + insert) when the event has any.
  if (questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  const firstEventId = desired[0]?.eventId;
  await logActivity(`Attendee '${parsed.name}' updated`, firstEventId);
  const target = parsed.returnUrl || `/admin/attendees/${attendeeId}`;
  return { ok: true, response: redirect(target, `Updated ${parsed.name}`, true) };
};

// ---------------------------------------------------------------------------
// POST route exports
// ---------------------------------------------------------------------------

/** Handle POST /admin/attendees/new — create a new attendee. */
export const handleAttendeeNewPost: TypedRouteHandler<"POST /admin/attendees/new"> =
  handleSubmit("create", null);

/** Handle POST /admin/attendees/:attendeeId — update an existing attendee. */
export const handleAttendeeEditPost: TypedRouteHandler<"POST /admin/attendees/:attendeeId"> =
  (request, { attendeeId }) => handleSubmit("edit", attendeeId)(request);
