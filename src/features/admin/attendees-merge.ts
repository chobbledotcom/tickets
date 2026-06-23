/**
 * Admin attendee merge routes
 */

/* jscpd:ignore-start */
import { filter, map, pipe } from "#fp";
import { createEntityRouteHandlers } from "#routes/admin/entity-handlers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import type { AttendeeRouteParams } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  decryptAttendeeOrNull,
  decryptAttendees,
  getAttendeesByTokens,
  LISTING_ATTENDEE_ROW_COLS,
  type ListingAttendeeRow,
  updateAttendeePII,
} from "#shared/db/attendees.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  applyAttendeeMerge,
  bookingKey,
  buildAttendeeMergeDiff,
  validateAttendeeMergeDecision,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  MergeAnswerChoice,
  MergeBookingChoice,
  MergeValueChoice,
} from "#shared/merge/attendee-merge-types.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import { adminMergeAttendeePage } from "#templates/admin/attendees.tsx";

/* jscpd:ignore-end */

/** Load and decrypt a target attendee by ID for merge operations */
const loadMergeTarget = async (
  attendeeId: number,
): Promise<Attendee | null> => {
  const pk = await requireRequestPrivateKey();
  const raw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  return decryptAttendeeOrNull(raw, pk);
};

/** Look up and decrypt a source attendee by ticket token */
const loadMergeSource = async (
  token: string,
): Promise<{
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: ListingAttendeeRow[];
} | null> => {
  const pk = await requireRequestPrivateKey();
  const results = await getAttendeesByTokens([token]);
  const raw = results[0];
  if (!raw) return null;
  // Cast to Attendee for decryption — only pii_blob is used by decryptAttendees
  // decryptAttendees always returns the same-length array — safe to index directly
  const decrypted = (
    await decryptAttendees([raw as unknown as Attendee], pk)
  )[0]!;
  return {
    address: decrypted.address,
    bookings: raw.bookings,
    email: decrypted.email,
    id: raw.id,
    name: decrypted.name,
    phone: decrypted.phone,
    special_instructions: decrypted.special_instructions,
    ticket_token: decrypted.ticket_token,
  };
};

/** Curried: load merge target then render with flash */
const mergeAttendeePage =
  (request: Request, session: AuthSession) =>
  (target: Attendee): Response => {
    const flash = applyFlash(request);
    return htmlResponse(
      adminMergeAttendeePage(target, null, null, session, flash.error),
    );
  };

/** Load all listing_attendees rows for an attendee */
const loadAttendeeBookings = (
  attendeeId: number,
): Promise<ListingAttendeeRow[]> =>
  queryAll<ListingAttendeeRow>(
    `SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees WHERE attendee_id = ? ORDER BY start_at, listing_id`,
    [attendeeId],
  );

/** Collect unique listing IDs from two sets of bookings */
const collectListingIds = (
  targetBookings: ListingAttendeeRow[],
  sourceBookings: ListingAttendeeRow[],
): number[] => {
  const ids = new Set<number>();
  for (const b of targetBookings) ids.add(b.listing_id);
  for (const b of sourceBookings) ids.add(b.listing_id);
  return [...ids];
};

type MergeSource = NonNullable<Awaited<ReturnType<typeof loadMergeSource>>>;
type MergeSummary = Awaited<ReturnType<typeof applyAttendeeMerge>>["summary"];

/** Extract PII subset for merge diff/apply input */
const extractSourcePii = (source: MergeSource) => ({
  address: source.address,
  email: source.email,
  name: source.name,
  phone: source.phone,
  special_instructions: source.special_instructions,
});

const extractTargetPii = (target: Attendee) => ({
  address: target.address,
  email: target.email,
  name: target.name,
  phone: target.phone,
  special_instructions: target.special_instructions,
});

/** Build merge diff from source + target */
const buildMergeDiffFor = async (
  target: Attendee,
  source: MergeSource,
  attendeeId: number,
): Promise<AttendeeMergeDiff> => {
  const targetBookings = await loadAttendeeBookings(attendeeId);
  const allListingIds = collectListingIds(targetBookings, source.bookings);
  const { questions } = await getQuestionsWithListingIds(allListingIds);

  return buildAttendeeMergeDiff(
    {
      sourceBookings: source.bookings,
      sourceId: source.id,
      sourcePii: extractSourcePii(source),
      targetBookings,
      targetId: attendeeId,
      targetPii: extractTargetPii(target),
    },
    questions,
  );
};

/** Resolve the (possibly-source) value of a PII field based on decision */
const pickPiiField = <K extends keyof MergeSource>(
  decision: AttendeeMergeDecisionInput,
  field: K & string,
  source: MergeSource,
  target: Attendee,
): string => {
  const decisionChoice = decision.pii[field];
  const sourceVal = source[field] as unknown as string;
  const targetVal = target[field as keyof Attendee] as unknown as string;
  return decisionChoice === "source" ? sourceVal : targetVal;
};

/** Update target attendee PII based on merge decisions */
const updateTargetPiiFromDecision = (
  attendeeId: number,
  decision: AttendeeMergeDecisionInput,
  source: MergeSource,
  target: Attendee,
): Promise<unknown> =>
  updateAttendeePII(attendeeId, {
    address: pickPiiField(decision, "address", source, target),
    email: pickPiiField(decision, "email", source, target),
    name: pickPiiField(decision, "name", source, target),
    payment_id: target.payment_id,
    phone: pickPiiField(decision, "phone", source, target),
    special_instructions: pickPiiField(
      decision,
      "special_instructions",
      source,
      target,
    ),
    ticket_token: target.ticket_token,
  });

/** Build labeled count strings from summary fields, omitting zero-count entries */
const mergeCountParts = (fields: Array<[number, string]>): string[] =>
  pipe(
    filter(([count]: [number, string]) => count > 0),
    map(([count, label]: [number, string]) => `${count} ${label}`),
  )(fields);

/** Build activity log message parts for a merge summary */
const buildMergeLogParts = (
  summary: MergeSummary,
  sourceName: string,
  mergedPiiName: string,
): string[] => [
  `Attendee '${sourceName}' merged into '${mergedPiiName}'`,
  ...mergeCountParts([
    [summary.bookingsMoved, "booking(s) moved"],
    [summary.bookingsSkipped, "booking(s) skipped"],
    [summary.bookingsReplacedTarget, "booking(s) replaced"],
    [summary.answersTakenFromSource, "answer(s) from source"],
    [summary.answersCleared, "answer(s) cleared"],
  ]),
];

/** Build flash message parts for a merge */
const buildMergeFlashParts = (
  summary: MergeSummary,
  sourceName: string,
  mergedPiiName: string,
): string[] => [
  `Merged ${sourceName} into ${mergedPiiName}`,
  ...mergeCountParts([
    [summary.bookingsMoved, "booking(s) moved"],
    [summary.bookingsSkipped, "booking(s) skipped"],
  ]),
];

/** Validate merge POST preconditions, returning an error Response or the source */
const validateMergePostInput = async (
  attendeeId: number,
  form: FormParams,
): Promise<
  | { ok: true; source: MergeSource; sourceToken: string }
  | { ok: false; response: Response }
> => {
  const sourceToken = form.getString("source_token");
  if (!sourceToken) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge`,
        "Source token is required",
      ),
    };
  }

  const source = await loadMergeSource(sourceToken);
  if (!source) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        "Ticket token not found",
      ),
    };
  }

  if (source.id === attendeeId) {
    return {
      ok: false,
      response: errorRedirect(
        `/admin/attendees/${attendeeId}/merge`,
        "Cannot merge an attendee with themselves",
      ),
    };
  }

  return { ok: true, source, sourceToken };
};

/** Apply merge decisions and return the success redirect response */
const applyMergeDecisions = async (
  attendeeId: number,
  target: Attendee,
  source: MergeSource,
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): Promise<Response> => {
  const result = await applyAttendeeMerge({
    decision,
    diff,
    privateKey: await requireRequestPrivateKey(),
    sourceId: source.id,
    sourcePii: extractSourcePii(source),
    targetId: attendeeId,
    targetPii: {
      ...extractTargetPii(target),
      payment_id: target.payment_id,
      ticket_token: target.ticket_token,
    },
  });

  const mergedPiiName =
    decision.pii.name === "source" ? source.name : target.name;
  await updateTargetPiiFromDecision(attendeeId, decision, source, target);

  const { summary } = result;
  await logActivity(
    buildMergeLogParts(summary, source.name, mergedPiiName).join(". "),
    target.listing_id,
    attendeeId,
  );

  return redirect(
    `/admin/attendees/${attendeeId}`,
    buildMergeFlashParts(summary, source.name, mergedPiiName).join(". "),
    true,
  );
};

/** Parse PII decisions from form (each field: "source" or "target") */
const parsePiiDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeValueChoice> => {
  const pii: Record<string, MergeValueChoice> = {};
  for (const field of diff.piiFields) {
    const val = form.getString(`pii_${field.field}`);
    pii[field.field] = val === "source" ? "source" : "target";
  }
  return pii;
};

/** Normalize a raw answer choice string into a MergeAnswerChoice */
const toAnswerChoice = (raw: string): MergeAnswerChoice => {
  if (raw === "source") return "source";
  if (raw === "clear") return "clear";
  return "target";
};

/** Parse answer decisions from form (only conflicting items) */
const parseAnswerDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeAnswerChoice> => {
  const answers: Record<string, MergeAnswerChoice> = {};
  for (const item of diff.answerItems) {
    if (item.conflict) {
      const val = form.getString(`answer_${item.questionId}`);
      answers[String(item.questionId)] = toAnswerChoice(val);
    }
  }
  return answers;
};

/** Normalize a raw booking choice string into a MergeBookingChoice */
const toBookingChoice = (raw: string): MergeBookingChoice => {
  if (raw === "take_source") return "take_source";
  if (raw === "skip_source") return "skip_source";
  return "keep_target";
};

/** Parse booking decisions from form (only non-moveable items) */
const parseBookingDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeBookingChoice> => {
  const bookings: Record<string, MergeBookingChoice> = {};
  for (const item of diff.bookingItems) {
    if (item.conflictClass !== "moveable") {
      const key = bookingKey(item.listingId, item.startAt);
      const val = form.getString(`booking_${key}`);
      bookings[key] = toBookingChoice(val);
    }
  }
  return bookings;
};

/** Parse merge decision form data into AttendeeMergeDecisionInput */
const parseMergeDecisionForm = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): AttendeeMergeDecisionInput => ({
  answers: parseAnswerDecisions(form, diff),
  bookings: parseBookingDecisions(form, diff),
  pii: parsePiiDecisions(form, diff),
  version: form.getString("merge_version"),
});

const handlers = createEntityRouteHandlers(
  loadMergeTarget,
  ({ attendeeId }: AttendeeRouteParams) => attendeeId,
);

/** Handle GET /admin/attendees/:attendeeId/merge — analyze + render decisions */
export const handleMergeGet = handlers.get(async (request, session, target) => {
  const token = getSearchParam(request, "token");
  const flash = applyFlash(request);
  if (!token) return mergeAttendeePage(request, session)(target);
  const source = await loadMergeSource(token);
  if (!source) {
    return htmlResponse(
      adminMergeAttendeePage(
        target,
        null,
        token,
        session,
        "Ticket token not found",
      ),
    );
  }
  if (source.id === target.id) {
    return htmlResponse(
      adminMergeAttendeePage(
        target,
        null,
        token,
        session,
        "Cannot merge an attendee with themselves",
      ),
    );
  }
  const diff = await buildMergeDiffFor(target, source, target.id);
  return htmlResponse(
    adminMergeAttendeePage(target, source, token, session, flash.error, diff),
  );
});

/** Handle POST /admin/attendees/:attendeeId/merge — validate + apply decisions */
export const handleMergePost = handlers.post(async (session, form, target) => {
  const input = await validateMergePostInput(target.id, form);
  if (!input.ok) return input.response;
  const { source, sourceToken } = input;
  const diff = await buildMergeDiffFor(target, source, target.id);
  const decision = parseMergeDecisionForm(form, diff);
  const validation = validateAttendeeMergeDecision(diff, decision);
  if (!validation.valid) {
    return htmlResponse(
      adminMergeAttendeePage(
        target,
        source,
        sourceToken,
        session,
        validation.errors.join("; "),
        diff,
      ),
    );
  }
  return applyMergeDecisions(target.id, target, source, diff, decision);
});
