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

import { compact, filter, map, pipe, uniqueBy } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import {
  type AtomicDesiredLine,
  applyAttendeeAtomicEdit,
  createAttendeeAtomic,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { ATTENDEE_LEFT_JOIN_SELECT, decryptAttendeeOrNull } from "#shared/db/attendees.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  getAllEvents,
} from "#shared/db/events.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForEvent,
  saveAttendeeAnswers,
  type QuestionWithAnswers,
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
  errorRedirect,
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

/** Build the empty create-mode form shell: one blank line with the
 * default daily date pre-filled (so the operator sees a concrete date). */
const buildEmptyCreateForm = (): ParsedAttendeeForm => {
  const todayIso = todayInTz(settings.timezone);
  const tomorrow = defaultNewDailyDate(todayIso);
  const blankLine: AttendeeFormLine = {
    date: tomorrow,
    error: null,
    event: null,
    eventId: 0,
    existingBooking: null,
    key: "",
    quantity: 1,
  };
  return {
    action: { kind: "save" },
    address: "",
    email: "",
    lines: [blankLine],
    name: "",
    phone: "",
    returnUrl: "",
    special_instructions: "",
  };
};

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
  // Always append one blank line so the operator has somewhere to type a
  // new registration without clicking "Add Event Line" first.
  lines.push({
    date: "",
    error: null,
    event: null,
    eventId: 0,
    existingBooking: null,
    key: "",
    quantity: 1,
  });
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

/** Load custom questions + currently-selected answers for the attendee's
 * first existing event (edit mode only). Matches the pre-unified-form
 * behavior of showing questions for the first booked event. */
const loadQuestionsContext = async (
  attendeeId: number,
  firstEventId: number | null,
): Promise<{
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
}> => {
  if (firstEventId === null) return { questions: [], selectedAnswerIds: [] };
  const [questions, answersMap] = await Promise.all([
    getQuestionsForEvent(firstEventId),
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
      const flash = applyFlash(request);
      return htmlResponse(
        attendeeFormPage(
          { ...data, flashError: flash.error, flashSuccess: flash.success },
          session,
        ),
      );
    });

/** Handle GET /admin/attendees/:id — render the edit form preloaded. */
export const handleAttendeeEditGet: TypedRouteHandler<"GET /admin/attendees/:attendeeId"> =
  (request, { attendeeId }) =>
    requireSessionOr(request, async (session) => {
      const loaded = await loadAttendeeForEdit(session, attendeeId);
      if (!loaded) return notFoundResponse();
      const allEvents = await getEventsForSelector(null);
      const eventsById = new Map(allEvents.map((e) => [e.id, e]));
      const parsed = buildEditFormFromAttendee(
        loaded.attendee,
        loaded.existing,
        eventsById,
      );
      const firstEventId = loaded.existing[0]?.booking.event_id ?? null;
      const { questions, selectedAnswerIds } = await loadQuestionsContext(
        attendeeId,
        firstEventId,
      );
      const data = await buildTemplateData("edit", parsed, loaded.attendee, {
        questions,
        returnUrl: readReturnUrl(request),
        selectedAnswerIds,
      });
      const flash = applyFlash(request);
      return htmlResponse(
        attendeeFormPage(
          { ...data, flashError: flash.error, flashSuccess: flash.success },
          session,
        ),
      );
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
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;
  const existing = await loadExistingLines(attendeeId);
  return { attendee, existing };
};

// ---------------------------------------------------------------------------
// POST handlers — shared submit logic
// ---------------------------------------------------------------------------

/** Apply add-line / remove-line transformations to a parsed form.
 *
 * - `add_line`: re-render with one new blank line appended.
 * - `remove_line` on a NEW (unsaved) line: re-render with that line
 *   dropped. The operator gets the form back unsaved.
 * - `remove_line` on an EXISTING line: delete that event_attendees row
 *   directly and redirect back to the edit page with a flash. This
 *   preserves the old edit page's single-click "Remove" UX — the
 *   operator doesn't have to click "Save Attendee" afterwards.
 *
 * Returns `{ kind: "save" }` when the action was a plain save. */
const applyLineAction = async (
  parsed: ParsedAttendeeForm,
  attendeeId: number | null,
  todayIso: string,
): Promise<
  | { kind: "rerender"; parsed: ParsedAttendeeForm }
  | { kind: "redirect"; response: Response }
  | { kind: "save" }
> => {
  const action = parsed.action;
  if (action.kind === "add_line") {
    const tomorrow = defaultNewDailyDate(todayIso);
    const newLine: AttendeeFormLine = {
      date: tomorrow,
      error: null,
      event: null,
      eventId: 0,
      existingBooking: null,
      key: "",
      quantity: 1,
    };
    return {
      kind: "rerender",
      parsed: { ...parsed, lines: [...parsed.lines, newLine] },
    };
  }
  if (action.kind === "remove_line") {
    const idx = action.index;
    const target = parsed.lines[idx];
    // Existing booking — delete the event_attendees row and redirect.
    if (target?.existingBooking && attendeeId !== null) {
      const { unlinkAttendeeFromEvent } = await import(
        "#shared/db/attendees.ts"
      );
      const unlinkResult = await unlinkAttendeeFromEvent(
        attendeeId,
        target.existingBooking.event_id,
      );
      if (unlinkResult.attendeeDeleted) {
        return {
          kind: "redirect",
          response: redirect("/admin/", "Attendee removed", true),
        };
      }
      const eventName = target.event?.name ?? "event";
      return {
        kind: "redirect",
        response: redirect(
          `/admin/attendees/${attendeeId}`,
          `Removed from '${eventName}'`,
          true,
        ),
      };
    }
    // New / unsaved line — just drop it from the form.
    const lines = parsed.lines.filter((_, i) => i !== idx);
    return {
      kind: "rerender",
      parsed: {
        ...parsed,
        lines: lines.length > 0 ? lines : [{
          date: defaultNewDailyDate(todayIso),
          error: null,
          event: null,
          eventId: 0,
          existingBooking: null,
          key: "",
          quantity: 1,
        }],
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
      handleSubmitInner(mode, attendeeId, request, session, form),
    );

/** Inner submit logic — extracted so the create/edit wrappers can pass
 * their own identity without conditionals in the hot path. */
const handleSubmitInner = async (
  mode: "create" | "edit",
  attendeeId: number | null,
  _request: Request,
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
    const firstEventId = loaded.existing[0]?.booking.event_id ?? null;
    const ctx = await loadQuestionsContext(attendeeId, firstEventId);
    questions = ctx.questions;
    selectedAnswerIds = ctx.selectedAnswerIds;
  }

  const allEvents = await getAllEvents();
  const eventsById = new Map(allEvents.map((e) => [e.id, e]));
  const parsed = parseAttendeeForm(form, eventsById, existingByKey);

  // Step 1: line-action re-render (no save).
  const todayIso = todayInTz(settings.timezone);
  const lineAction = await applyLineAction(parsed, attendeeId, todayIso);
  if (lineAction.kind === "rerender") {
    const data = await buildTemplateData(mode, lineAction.parsed, attendee, {
      questions,
      returnUrl: parsed.returnUrl,
      selectedAnswerIds,
    });
    return htmlResponse(attendeeFormPage(data, session));
  }
  if (lineAction.kind === "redirect") {
    return lineAction.response;
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

  // Step 4: apply atomic create or edit.
  if (mode === "create") {
    return applyCreate(parsed, session);
  }

  // Parse question answers from the form (edit mode only).
  const answerIds = parseQuestionAnswers(form, questions);
  return applyEdit(attendeeId!, parsed, attendee!, questions, answerIds);
};

/** Read submitted question answers from the form, filtered to valid options. */
const parseQuestionAnswers = (
  form: FormParams,
  questions: QuestionWithAnswers[],
): number[] => {
  const answerIds: number[] = [];
  for (const q of questions) {
    const raw = form.get(`question_${q.id}`);
    if (raw) {
      const answerId = Number.parseInt(raw, 10);
      if (q.answers.some((a) => a.id === answerId)) {
        answerIds.push(answerId);
      }
    }
  }
  return answerIds;
};

/** Run the atomic create flow + redirect. */
const applyCreate = async (
  parsed: ParsedAttendeeForm,
  _session: AuthSession,
): Promise<Response> => {
  const input = toCreateInput(parsed);
  const createResult = await createAttendeeAtomic(input);
  if (!createResult.success) {
    if (createResult.reason === "encryption_error") {
      logError({
        code: ErrorCode.ENCRYPT_FAILED,
        detail: "manual add attendee (unified form)",
      });
      return errorRedirect(
        "/admin/attendees/new",
        "Encryption error — check that DB_ENCRYPTION_KEY is configured",
      );
    }
    return errorRedirect(
      "/admin/attendees/new",
      "Not enough spots available for one or more selected events",
    );
  }

  const firstEventId = parsed.lines.find((line) => line.eventId > 0)!.eventId;
  const name = parsed.name;
  await logActivity(`Attendee '${name}' added manually`, firstEventId);

  const target = parsed.returnUrl || `/admin/attendees/${createResult.attendees[0]!.id}`;
  return redirect(target, `Added ${name}`, true);
};

/** Run the atomic edit flow + redirect. */
const applyEdit = async (
  attendeeId: number,
  parsed: ParsedAttendeeForm,
  attendee: Attendee,
  questions: QuestionWithAnswers[],
  answerIds: number[],
): Promise<Response> => {
  // Re-encrypt the PII blob with the (possibly) updated fields. The
  // atomic-update function takes the already-encrypted blob.
  const { buildPiiBlob, encryptPiiBlob } = await import(
    "#shared/db/attendees/pii.ts"
  );
  const encryptedPiiBlob = await encryptPiiBlob(
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
  );
  if (!encryptedPiiBlob) {
    logError({
      code: ErrorCode.ENCRYPT_FAILED,
      detail: "manual edit attendee (unified form)",
    });
    return errorRedirect(
      `/admin/attendees/${attendeeId}`,
      "Encryption error — check that DB_ENCRYPTION_KEY is configured",
    );
  }

  const desired: AtomicDesiredLine[] = toDesiredLines(parsed).map((line) => ({
    date: line.date,
    durationDays: line.durationDays,
    eventId: line.eventId,
    exists: line.exists,
    key: line.key,
    quantity: line.quantity,
  }));

  const editResult = await applyAttendeeAtomicEdit(
    attendeeId,
    encryptedPiiBlob,
    desired,
  );
  if (!editResult.success) {
    if (editResult.reason === "no_lines") {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "At least one event line is required",
      );
    }
    if (editResult.reason === "encryption_error") {
      return errorRedirect(
        `/admin/attendees/${attendeeId}`,
        "Encryption error — check that DB_ENCRYPTION_KEY is configured",
      );
    }
    return errorRedirect(
      `/admin/attendees/${attendeeId}`,
      "Capacity lost to a concurrent booking — please review and retry",
    );
  }

  // Save question answers (atomic delete + insert) when the event has any.
  if (questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  const firstEventId = desired[0]?.eventId;
  await logActivity(`Attendee '${parsed.name}' updated`, firstEventId);
  const target = parsed.returnUrl || `/admin/attendees/${attendeeId}`;
  return redirect(target, `Updated ${parsed.name}`, true);
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
