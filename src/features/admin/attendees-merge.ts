/**
 * Admin attendee merge routes
 */

/* jscpd:ignore-start */
import { filter, map, pipe, unique } from "#fp";
import { AUTH_FORM, formGuard } from "#routes/auth.ts";
import {
  type AttendeeRouteParams,
  createEntityHandler,
} from "#routes/entity.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import {
  decryptAttendeeOrNull,
  decryptAttendees,
} from "#shared/db/attendees/pii.ts";
import {
  getAttendeeRaw,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees/queries.ts";
import { getAttendeesByTokens } from "#shared/db/attendees/tokens.ts";
import { updateAttendeePII } from "#shared/db/attendees/update.ts";
import { queryAll } from "#shared/db/client.ts";
import { syncAttendeeContactTokens } from "#shared/db/contact-tokens.ts";
import { orRefusal } from "#shared/db/payment-admit-move.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions/queries.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  applyAttendeeMerge,
  buildAttendeeMergeDiff,
  conflictBookingEntries,
  validateAttendeeMergeDecision,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  MergeAnswerChoice,
  MergeBookingChoice,
  MergeMoneyChoice,
  MergeValueChoice,
} from "#shared/merge/attendee-merge-types.ts";
import type { ParamsRoute } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ContactInfo } from "#shared/types.ts";
import { AttendeeMergePanel } from "#templates/admin/attendees/merge-panel.tsx";

/* jscpd:ignore-end */

/** Load and decrypt a target attendee by ID for merge operations */
const loadMergeTarget = async (
  attendeeId: number,
): Promise<Attendee | null> => {
  const pk = await requireRequestPrivateKey();
  const raw = await getAttendeeRaw(attendeeId);
  return decryptAttendeeOrNull(raw, pk);
};

/** Look up and decrypt a source attendee by ticket token */
const loadMergeSource = async (
  token: string,
): Promise<
  | (ContactInfo & {
      id: number;
      lat: string;
      lng: string;
      payment_id: string;
      ticket_token: string;
      bookings: ListingAttendeeRow[];
    })
  | null
> => {
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
    lat: decrypted.lat,
    lng: decrypted.lng,
    name: decrypted.name,
    payment_id: decrypted.payment_id,
    phone: decrypted.phone,
    special_instructions: decrypted.special_instructions,
    ticket_token: decrypted.ticket_token,
  };
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
): number[] =>
  unique([...targetBookings, ...sourceBookings].map((b) => b.listing_id));

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
const updateTargetPiiFromDecision = async (
  attendeeId: number,
  decision: AttendeeMergeDecisionInput,
  source: MergeSource,
  target: Attendee,
): Promise<void> => {
  // The pinned location belongs to the address it was pinned for, so it
  // follows whichever side's address the operator keeps. When the kept side
  // has no pin but the OTHER side pinned the very same address text, keep
  // that pin — identical addresses render as one "(same)" value on the merge
  // form, so dropping the only pin there would be a silent loss.
  const kept = decision.pii.address === "source" ? source : target;
  const other = kept === source ? target : source;
  const keptIsPinned = Boolean(kept.lat && kept.lng);
  const addressFrom =
    keptIsPinned || kept.address !== other.address ? kept : other;
  const email = pickPiiField(decision, "email", source, target);
  const phone = pickPiiField(decision, "phone", source, target);
  await updateAttendeePII(attendeeId, {
    address: pickPiiField(decision, "address", source, target),
    email,
    lat: addressFrom.lat,
    lng: addressFrom.lng,
    name: pickPiiField(decision, "name", source, target),
    payment_id: target.payment_id,
    phone,
    special_instructions: pickPiiField(
      decision,
      "special_instructions",
      source,
      target,
    ),
    ticket_token: target.ticket_token,
  });
  // The target keeps its ticket token, but the merge may switch its kept email
  // or phone to the source's value. Keep that token attached to whichever
  // contact now owns it. The deleted source's token is left stale and simply
  // filtered out on read.
  await syncAttendeeContactTokens({
    after: { email, phone },
    before: { email: target.email, phone: target.phone },
    firstRealBooking: false,
    hasBooking: true,
    privateKey: await requireRequestPrivateKey(),
    source: "admin",
    ticketToken: target.ticket_token,
  });
};

/** Build labeled count strings from summary fields, omitting zero-count entries */
const mergeCountParts = (fields: [number, string][]): string[] =>
  pipe(
    filter(([count]: [number, string]) => count > 0),
    map(([count, label]) => `${count} ${label}`),
  )(fields);

/** The booking-movement counts every merge message leads with, before each
 *  surface adds its own (the log is fuller; the flash is a short confirmation). */
const bookingMoveParts = (summary: MergeSummary): [number, string][] => [
  [summary.bookingsMoved, "booking(s) moved"],
  [summary.bookingsSkipped, "booking(s) skipped"],
];

/** Build a merge message's parts: a lead line, then the changed-count phrases
 * (the shared booking moves, plus the surface's own extra counts). */
const mergeMessageParts =
  (
    lead: (sourceName: string, mergedPiiName: string) => string,
    extraCounts: (summary: MergeSummary) => [number, string][],
  ) =>
  (
    summary: MergeSummary,
    sourceName: string,
    mergedPiiName: string,
  ): string[] => [
    lead(sourceName, mergedPiiName),
    ...mergeCountParts([...bookingMoveParts(summary), ...extraCounts(summary)]),
  ];

/** Build activity log message parts for a merge summary */
const buildMergeLogParts = mergeMessageParts(
  (sourceName, mergedPiiName) =>
    `Attendee '${sourceName}' merged into '${mergedPiiName}'`,
  (summary) => [
    [summary.bookingsReplacedTarget, "booking(s) replaced"],
    [summary.bookingsCredited, "payment(s) kept as credit"],
    [summary.bookingsWrittenOff, "payment(s) written off"],
    [summary.answersTakenFromSource, "answer(s) from source"],
    [summary.answersCleared, "answer(s) cleared"],
  ],
);

/** Build flash message parts for a merge */
const buildMergeFlashParts = mergeMessageParts(
  (sourceName, mergedPiiName) => `Merged ${sourceName} into ${mergedPiiName}`,
  (summary) => [
    [summary.bookingsCredited, "payment(s) credited"],
    [summary.bookingsWrittenOff, "payment(s) written off"],
  ],
);

/** Validate merge POST preconditions, returning an error Response or the source */
const validateMergePostInput = async (
  attendeeId: number,
  form: FormParams,
): Promise<
  | { ok: true; source: MergeSource; sourceToken: string }
  | { ok: false; response: Response }
> => {
  const actionsTab = `/admin/attendees/${attendeeId}/actions`;
  const sourceToken = form.getString("source_token");
  if (!sourceToken) {
    return {
      ok: false,
      response: errorRedirect(actionsTab, "Source token is required"),
    };
  }

  const source = await loadMergeSource(sourceToken);
  if (!source) {
    return {
      ok: false,
      response: errorRedirect(
        `${actionsTab}?token=${encodeURIComponent(sourceToken)}`,
        "Ticket token not found",
      ),
    };
  }

  if (source.id === attendeeId) {
    return {
      ok: false,
      response: errorRedirect(
        actionsTab,
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
    sourcePaymentId: source.payment_id,
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

/** Build a per-conflict decision Record by parsing each NON-moveable booking's
 *  form field (keyed by "listingId:startAt"). A `parse` result of `undefined`
 *  leaves the entry out — so a blank money choice stays absent and validation can
 *  demand it, while `toBookingChoice` (which always resolves) fills every row. */
const parseConflictDecisions = <T>(
  diff: AttendeeMergeDiff,
  parse: (key: string) => T | undefined,
): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const { key } of conflictBookingEntries(diff)) {
    const value = parse(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/** Parse booking decisions from form (only non-moveable items) */
const parseBookingDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeBookingChoice> =>
  parseConflictDecisions(diff, (key) =>
    toBookingChoice(form.getString(`booking_${key}`)),
  );

/** Normalize a raw money choice; an empty/unknown value is left ABSENT so
 *  validation can require an explicit decision (decision 17 — never defaulted). */
const toMoneyChoice = (raw: string): MergeMoneyChoice | undefined => {
  if (raw === "credit") return "credit";
  if (raw === "writeoff") return "writeoff";
  return;
};

/** Parse money decisions from form (only conflicting items); a blank choice is
 *  omitted so validateAttendeeMergeDecision rejects the merge until the operator
 *  decides what happens to the discarded booking's money. */
const parseMoneyDecisions = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): Record<string, MergeMoneyChoice> =>
  parseConflictDecisions(diff, (key) =>
    toMoneyChoice(form.getString(`money_${key}`)),
  );

/** Parse merge decision form data into AttendeeMergeDecisionInput */
const parseMergeDecisionForm = (
  form: FormParams,
  diff: AttendeeMergeDiff,
): AttendeeMergeDecisionInput => ({
  answers: parseAnswerDecisions(form, diff),
  bookings: parseBookingDecisions(form, diff),
  money: parseMoneyDecisions(form, diff),
  pii: parsePiiDecisions(form, diff),
  version: form.getString("merge_version"),
});

const mergeHandler = createEntityHandler<AttendeeRouteParams, Attendee>(
  ({ attendeeId }) => loadMergeTarget(attendeeId),
)(formGuard(AUTH_FORM));

/**
 * Build the merge panel for the attendee page's Actions tab: the token search
 * form alone, or — when a `?token=` search is in flight — the source preview
 * and decision form (with an inline message when the token doesn't resolve).
 */
export const loadMergePanel = async (
  target: Attendee,
  token: string,
): Promise<JSX.Element> => {
  if (!token) return AttendeeMergePanel(target, null, null);
  const source = await loadMergeSource(token);
  if (!source) {
    return AttendeeMergePanel(target, null, token, "Ticket token not found");
  }
  if (source.id === target.id) {
    return AttendeeMergePanel(
      target,
      null,
      token,
      "Cannot merge an attendee with themselves",
    );
  }
  const diff = await buildMergeDiffFor(target, source, target.id);
  return AttendeeMergePanel(target, source, token, undefined, diff);
};

/** Handle POST /admin/attendees/:attendeeId/merge — validate + apply decisions */
export const handleMergePost: ParamsRoute<AttendeeRouteParams> = mergeHandler(
  async (target, _session, form) => {
    const input = await validateMergePostInput(target.id, form);
    if (!input.ok) return input.response;
    const { source, sourceToken } = input;
    const diff = await buildMergeDiffFor(target, source, target.id);
    const decision = parseMergeDecisionForm(form, diff);
    // Where anything that stops the merge sends the operator: back to the
    // Actions tab's merge panel, where the decision radios reset (they always
    // have) but the message flashes and the search re-runs.
    const mergePanel = `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`;
    const validation = validateAttendeeMergeDecision(diff, decision);
    if (!validation.valid) {
      return errorRedirect(mergePanel, validation.errors.join("; "));
    }
    return orRefusal(
      () => applyMergeDecisions(target.id, target, source, diff, decision),
      (message) => errorRedirect(mergePanel, message),
    );
  },
);
