/**
 * Attendee merge service — single orchestration point for merge rules.
 *
 * Two-step flow:
 * 1. buildAttendeeMergeDiff: compute a diff between target and source
 * 2. applyAttendeeMerge: apply explicit decisions from the admin
 */

import { filter, map, reduce } from "#fp";
import type { EventAttendeeRow } from "#lib/db/attendee-types.ts";
import { executeBatch } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import {
  getAttendeeAnswersByQuestion,
  saveAttendeeAnswersByQuestion,
} from "#lib/db/questions.ts";
import type {
  ApplyAttendeeMergeInput,
  AttendeeMergeApplyResult,
  AttendeeMergeApplySummary,
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  AttendeeMergeDiffAnswerItem,
  AttendeeMergeDiffBookingItem,
  AttendeeMergeDiffPiiField,
  AttendeeMergeValidationResult,
  BookingConflictClass,
  BuildAttendeeMergeDiffInput,
} from "#lib/merge/attendee-merge-types.ts";

// ---------------------------------------------------------------------------
// PII field definitions
// ---------------------------------------------------------------------------

const PII_FIELDS: {
  field: string;
  label: string;
  multiline: boolean;
}[] = [
  { field: "name", label: "Name", multiline: false },
  { field: "email", label: "Email", multiline: false },
  { field: "phone", label: "Phone", multiline: false },
  { field: "address", label: "Address", multiline: true },
  {
    field: "special_instructions",
    label: "Special Instructions",
    multiline: true,
  },
];

// ---------------------------------------------------------------------------
// Booking key helper
// ---------------------------------------------------------------------------

/** Attendee answer map: questionId -> { answerId, answerText } */
type AnswerMap = Map<number, { answerId: number; answerText: string }>;

/** Unique key for a booking: "eventId:startAt" */
export const bookingKey = (eventId: number, startAt: string | null): string =>
  `${eventId}:${startAt ?? "null"}`;

/** Booking key for a diff item */
const itemBookingKey = (item: AttendeeMergeDiffBookingItem): string =>
  bookingKey(item.eventId, item.startAt);

/** Determine the conflict label for a non-moveable booking item */
export const bookingConflictLabel = (
  item: AttendeeMergeDiffBookingItem,
): string =>
  item.conflictClass === "duplicate" ? "Duplicate" : "Conflicting metadata";

/** Whether a set of booking items contains any non-moveable conflicts */
export const hasBookingConflicts = (
  items: AttendeeMergeDiffBookingItem[],
): boolean => items.some((b) => b.conflictClass !== "moveable");

/** Determine display label for a non-conflicting answer item */
export const nonConflictAnswerLabel = (
  item: AttendeeMergeDiffAnswerItem,
): { answer: string; from: string } => {
  if (item.targetAnswerText !== null) {
    return { answer: item.targetAnswerText, from: "target" };
  }
  return { answer: item.sourceAnswerText!, from: "source" };
};

// ---------------------------------------------------------------------------
// Version hash
// ---------------------------------------------------------------------------

/** Compute a simple version string from diff inputs for stale-preview detection */
const computeVersion = (
  targetId: number,
  sourceId: number,
  targetAnswers: AnswerMap,
  sourceAnswers: AnswerMap,
  targetBookings: EventAttendeeRow[],
  sourceBookings: EventAttendeeRow[],
): string => {
  const parts = [
    `t:${targetId}`,
    `s:${sourceId}`,
    `ta:${map((e: [number, { answerId: number }]) => `${e[0]}=${e[1].answerId}`)([...targetAnswers.entries()]).join(",")}`,
    `sa:${map((e: [number, { answerId: number }]) => `${e[0]}=${e[1].answerId}`)([...sourceAnswers.entries()]).join(",")}`,
    `tb:${map((b: EventAttendeeRow) => bookingKey(b.event_id, b.start_at))(targetBookings).join(",")}`,
    `sb:${map((b: EventAttendeeRow) => bookingKey(b.event_id, b.start_at))(sourceBookings).join(",")}`,
  ];
  return parts.join("|");
};

// ---------------------------------------------------------------------------
// buildAttendeeMergeDiff
// ---------------------------------------------------------------------------

/** Build a merge diff between target and source attendees */
export const buildAttendeeMergeDiff = async (
  input: BuildAttendeeMergeDiffInput,
  questions: QuestionWithAnswers[],
): Promise<AttendeeMergeDiff> => {
  const {
    targetId,
    sourceId,
    targetPii,
    sourcePii,
    targetBookings,
    sourceBookings,
  } = input;

  // --- PII fields ---
  const piiFields: AttendeeMergeDiffPiiField[] = map(
    (def: { field: string; label: string; multiline: boolean }) => {
      const targetValue =
        (targetPii as Record<string, string>)[def.field] || "";
      const sourceValue =
        (sourcePii as Record<string, string>)[def.field] || "";
      return {
        ...def,
        targetValue,
        sourceValue,
        same: targetValue === sourceValue,
      };
    },
  )(PII_FIELDS);

  // --- Custom question answers ---
  const [targetAnswers, sourceAnswers] = await Promise.all([
    getAttendeeAnswersByQuestion(targetId),
    getAttendeeAnswersByQuestion(sourceId),
  ]);

  const answerItems: AttendeeMergeDiffAnswerItem[] = buildAnswerDiffItems(
    questions,
    targetAnswers,
    sourceAnswers,
  );

  // --- Bookings ---
  const bookingItems = buildBookingDiffItems(targetBookings, sourceBookings);

  const version = computeVersion(
    targetId,
    sourceId,
    targetAnswers,
    sourceAnswers,
    targetBookings,
    sourceBookings,
  );

  return { targetId, sourceId, piiFields, answerItems, bookingItems, version };
};

/** Build answer diff items for all questions relevant to both attendees */
const buildAnswerDiffItems = (
  questions: QuestionWithAnswers[],
  targetAnswers: AnswerMap,
  sourceAnswers: AnswerMap,
): AttendeeMergeDiffAnswerItem[] => {
  // Collect all question IDs from both target and source answers
  const relevantQuestionIds = new Set<number>();
  for (const [qid] of targetAnswers) relevantQuestionIds.add(qid);
  for (const [qid] of sourceAnswers) relevantQuestionIds.add(qid);

  // Build lookup for question text from the provided questions
  const questionTextMap = new Map<number, string>();
  for (const q of questions) questionTextMap.set(q.id, q.text);

  return reduce((acc: AttendeeMergeDiffAnswerItem[], qid: number) => {
    const ta = targetAnswers.get(qid) ?? null;
    const sa = sourceAnswers.get(qid) ?? null;
    const conflict = ta !== null && sa !== null && ta.answerId !== sa.answerId;
    acc.push({
      questionId: qid,
      questionText: questionTextMap.get(qid) ?? `Question #${qid}`,
      targetAnswerId: ta?.answerId ?? null,
      targetAnswerText: ta?.answerText ?? null,
      sourceAnswerId: sa?.answerId ?? null,
      sourceAnswerText: sa?.answerText ?? null,
      conflict,
    });
    return acc;
  }, [] as AttendeeMergeDiffAnswerItem[])([...relevantQuestionIds]);
};

/** Build booking diff items comparing source bookings against target */
const buildBookingDiffItems = (
  targetBookings: EventAttendeeRow[],
  sourceBookings: EventAttendeeRow[],
): AttendeeMergeDiffBookingItem[] => {
  // Index target bookings by key
  const targetByKey = reduce(
    (acc: Map<string, EventAttendeeRow>, b: EventAttendeeRow) => {
      acc.set(bookingKey(b.event_id, b.start_at), b);
      return acc;
    },
    new Map<string, EventAttendeeRow>(),
  )(targetBookings);

  return map((sb: EventAttendeeRow): AttendeeMergeDiffBookingItem => {
    const key = bookingKey(sb.event_id, sb.start_at);
    const tb = targetByKey.get(key) ?? null;
    let conflictClass: BookingConflictClass;

    if (!tb) {
      conflictClass = "moveable";
    } else if (
      tb.quantity === sb.quantity &&
      tb.price_paid === sb.price_paid &&
      tb.checked_in === sb.checked_in &&
      tb.refunded === sb.refunded
    ) {
      conflictClass = "duplicate";
    } else {
      conflictClass = "conflicting_metadata";
    }

    return {
      eventId: sb.event_id,
      startAt: sb.start_at,
      sourceBooking: sb,
      targetBooking: tb,
      conflictClass,
    };
  })(sourceBookings);
};

// ---------------------------------------------------------------------------
// validateAttendeeMergeDecision
// ---------------------------------------------------------------------------

/** Validate that the admin's decisions cover all required conflicts */
export const validateAttendeeMergeDecision = (
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): AttendeeMergeValidationResult => {
  const errors: string[] = [];

  // Check version match
  if (decision.version !== diff.version) {
    errors.push(
      "The merge preview is out of date. Please reload and try again.",
    );
    return { valid: false, errors };
  }

  // Check answer decisions for conflicts
  const conflictingAnswers = filter(
    (a: AttendeeMergeDiffAnswerItem) => a.conflict,
  )(diff.answerItems);
  for (const item of conflictingAnswers) {
    const key = String(item.questionId);
    const choice = decision.answers[key];
    if (!choice) {
      errors.push(`Missing decision for question: ${item.questionText}`);
    }
  }

  // Check booking decisions for conflicts
  const conflictingBookings = filter(
    (b: AttendeeMergeDiffBookingItem) => b.conflictClass !== "moveable",
  )(diff.bookingItems);
  for (const item of conflictingBookings) {
    if (!decision.bookings[itemBookingKey(item)]) {
      errors.push(
        `Missing decision for booking: Event #${item.eventId}${item.startAt ? ` (${item.startAt.slice(0, 10)})` : ""}`,
      );
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
};

// ---------------------------------------------------------------------------
// applyAttendeeMerge
// ---------------------------------------------------------------------------

/** Apply a validated merge with explicit decisions */
export const applyAttendeeMerge = async (
  input: ApplyAttendeeMergeInput,
): Promise<AttendeeMergeApplyResult> => {
  const { targetId, sourceId, targetPii, sourcePii, diff, decision } = input;

  // --- 1. Apply PII decisions ---
  const piiFieldsFromSource: string[] = [];
  const mergedPii = { ...targetPii };
  for (const field of diff.piiFields) {
    if (decision.pii[field.field] === "source") {
      (mergedPii as Record<string, string>)[field.field] = (
        sourcePii as Record<string, string>
      )[field.field];
      piiFieldsFromSource.push(field.field);
    }
  }

  // --- 2. Apply answer decisions ---
  const targetAnswers = await getAttendeeAnswersByQuestion(targetId);

  let answersKept = 0;
  let answersTakenFromSource = 0;
  let answersCleared = 0;

  // Start with target's answers as the base
  const finalAnswers = new Map<number, number>();
  for (const [qid, { answerId }] of targetAnswers) {
    finalAnswers.set(qid, answerId);
  }

  // Process each answer item from the diff
  for (const item of diff.answerItems) {
    const qid = item.questionId;
    const choice = decision.answers[String(qid)];

    if (item.conflict) {
      // Conflicting — must have an explicit decision
      if (choice === "source" && item.sourceAnswerId !== null) {
        finalAnswers.set(qid, item.sourceAnswerId);
        answersTakenFromSource++;
      } else if (choice === "clear") {
        finalAnswers.delete(qid);
        answersCleared++;
      } else {
        // "target" or default — keep target
        answersKept++;
      }
    } else if (item.sourceAnswerId !== null && item.targetAnswerId === null) {
      // Source has answer, target doesn't — adopt source answer
      finalAnswers.set(qid, item.sourceAnswerId);
      answersTakenFromSource++;
    } else if (item.targetAnswerId !== null) {
      answersKept++;
    }
  }

  // --- 3. Apply booking decisions ---
  let bookingsMoved = 0;
  let bookingsSkipped = 0;
  let bookingsReplacedTarget = 0;

  type BatchStatement = { sql: string; args: (number | string | null)[] };
  const insertStatements: BatchStatement[] = [];
  const deleteTargetBookingStatements: BatchStatement[] = [];

  /** Build an INSERT statement to copy a source booking to the target */
  const bookingInsert = (booking: EventAttendeeRow): BatchStatement => ({
    sql: `INSERT INTO event_attendees
            (event_id, attendee_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      booking.event_id,
      targetId,
      booking.start_at,
      booking.end_at,
      booking.quantity,
      booking.checked_in,
      booking.refunded,
      booking.price_paid,
      booking.attachment_downloads,
    ],
  });

  for (const item of diff.bookingItems) {
    const choice = decision.bookings[itemBookingKey(item)];

    if (item.conflictClass === "moveable") {
      // No conflict — move source booking to target
      insertStatements.push(bookingInsert(item.sourceBooking));
      bookingsMoved++;
    } else if (choice === "take_source" && item.targetBooking) {
      // Replace target booking with source booking
      deleteTargetBookingStatements.push({
        sql: `DELETE FROM event_attendees
              WHERE attendee_id = ? AND event_id = ?
              AND (start_at IS ? OR start_at = ?)`,
        args: [targetId, item.eventId, item.startAt, item.startAt],
      });
      insertStatements.push(bookingInsert(item.sourceBooking));
      bookingsReplacedTarget++;
    } else {
      // keep_target or skip_source — do nothing for this booking
      bookingsSkipped++;
    }
  }

  // --- 4. Execute all DB changes atomically ---
  await executeBatch([
    // Delete target bookings that are being replaced
    ...deleteTargetBookingStatements,
    // Insert moved/replaced source bookings
    ...insertStatements,
    // Clean up source attendee
    {
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
      args: [sourceId],
    },
    {
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
      args: [sourceId],
    },
    {
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
      args: [sourceId],
    },
    { sql: "DELETE FROM attendees WHERE id = ?", args: [sourceId] },
  ]);

  // Save merged answers for target
  await saveAttendeeAnswersByQuestion(targetId, finalAnswers);

  invalidateEventsCache();

  const summary: AttendeeMergeApplySummary = {
    piiFieldsFromSource,
    answersKept,
    answersTakenFromSource,
    answersCleared,
    bookingsMoved,
    bookingsSkipped,
    bookingsReplacedTarget,
  };

  return { success: true, summary };
};
