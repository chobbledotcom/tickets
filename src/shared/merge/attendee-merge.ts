/**
 * Attendee merge service — single orchestration point for merge rules.
 *
 * Two-step flow:
 * 1. buildAttendeeMergeDiff: compute a diff between target and source
 * 2. applyAttendeeMerge: apply explicit decisions from the admin
 */

import { filter, map, reduce } from "#fp";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { executeBatch, insert } from "#shared/db/client.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
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
} from "#shared/merge/attendee-merge-types.ts";

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

/** Unique key for a booking: "listingId:startAt" */
export const bookingKey = (listingId: number, startAt: string | null): string =>
  `${listingId}:${startAt ?? "null"}`;

/** Booking key for a diff item */
const itemBookingKey = (item: AttendeeMergeDiffBookingItem): string =>
  bookingKey(item.listingId, item.startAt);

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

/** Join mapped values with commas */
const joinMapped =
  <T>(fn: (item: T) => string) =>
  (items: T[]): string =>
    map(fn)(items).join(",");

const joinAnswerEntries = joinMapped(
  (e: [number, { answerId: number }]) => `${e[0]}=${e[1].answerId}`,
);

const joinBookingKeys = joinMapped((b: ListingAttendeeRow) =>
  bookingKey(b.listing_id, b.start_at),
);

/** Compute a simple version string from diff inputs for stale-preview detection */
const computeVersion = (
  targetId: number,
  sourceId: number,
  targetAnswers: AnswerMap,
  sourceAnswers: AnswerMap,
  targetBookings: ListingAttendeeRow[],
  sourceBookings: ListingAttendeeRow[],
): string => {
  const parts = [
    `t:${targetId}`,
    `s:${sourceId}`,
    `ta:${joinAnswerEntries([...targetAnswers.entries()])}`,
    `sa:${joinAnswerEntries([...sourceAnswers.entries()])}`,
    `tb:${joinBookingKeys(targetBookings)}`,
    `sb:${joinBookingKeys(sourceBookings)}`,
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
        same: targetValue === sourceValue,
        sourceValue,
        targetValue,
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

  return { answerItems, bookingItems, piiFields, sourceId, targetId, version };
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
      conflict,
      questionId: qid,
      questionText: questionTextMap.get(qid) ?? `Question #${qid}`,
      sourceAnswerId: sa?.answerId ?? null,
      sourceAnswerText: sa?.answerText ?? null,
      targetAnswerId: ta?.answerId ?? null,
      targetAnswerText: ta?.answerText ?? null,
    });
    return acc;
  }, [] as AttendeeMergeDiffAnswerItem[])([...relevantQuestionIds]);
};

/** Build booking diff items comparing source bookings against target */
const buildBookingDiffItems = (
  targetBookings: ListingAttendeeRow[],
  sourceBookings: ListingAttendeeRow[],
): AttendeeMergeDiffBookingItem[] => {
  // Index target bookings by key
  const targetByKey = new Map(
    map(
      (b: ListingAttendeeRow) =>
        [bookingKey(b.listing_id, b.start_at), b] as const,
    )(targetBookings),
  );

  return map((sb: ListingAttendeeRow): AttendeeMergeDiffBookingItem => {
    const key = bookingKey(sb.listing_id, sb.start_at);
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
      conflictClass,
      listingId: sb.listing_id,
      sourceBooking: sb,
      startAt: sb.start_at,
      targetBooking: tb,
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
    return { errors, valid: false };
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
        `Missing decision for booking: Listing #${item.listingId}${
          item.startAt ? ` (${item.startAt.slice(0, 10)})` : ""
        }`,
      );
    }
  }

  return errors.length > 0 ? { errors, valid: false } : { valid: true };
};

// ---------------------------------------------------------------------------
// applyAttendeeMerge
// ---------------------------------------------------------------------------

type BatchStatement = { sql: string; args: (number | string | null)[] };

/** Apply PII decisions — mutates mergedPii and returns fields taken from source */
const applyPiiDecisions = (
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
  targetPii: Record<string, unknown>,
  sourcePii: Record<string, unknown>,
): { mergedPii: Record<string, unknown>; piiFieldsFromSource: string[] } => {
  const piiFieldsFromSource: string[] = [];
  const mergedPii = { ...targetPii };
  for (const field of diff.piiFields) {
    if (decision.pii[field.field] === "source") {
      (mergedPii as Record<string, string>)[field.field] = (
        sourcePii as Record<string, string>
      )[field.field]!;
      piiFieldsFromSource.push(field.field);
    }
  }
  return { mergedPii, piiFieldsFromSource };
};

/** Apply an answer decision item; returns counter deltas */
const takeSourceAnswer = (
  finalAnswers: Map<number, number>,
  qid: number,
  sourceAnswerId: number,
): { kept: number; taken: number; cleared: number } => {
  finalAnswers.set(qid, sourceAnswerId);
  return { cleared: 0, kept: 0, taken: 1 };
};

const applyAnswerDecision = (
  item: AttendeeMergeDiffAnswerItem,
  decision: AttendeeMergeDecisionInput,
  finalAnswers: Map<number, number>,
): { kept: number; taken: number; cleared: number } => {
  const qid = item.questionId;
  const choice = decision.answers[String(qid)];

  if (item.conflict) {
    if (choice === "source" && item.sourceAnswerId !== null) {
      return takeSourceAnswer(finalAnswers, qid, item.sourceAnswerId);
    }
    if (choice === "clear") {
      finalAnswers.delete(qid);
      return { cleared: 1, kept: 0, taken: 0 };
    }
    // "target" or default — keep target
    return { cleared: 0, kept: 1, taken: 0 };
  }
  if (item.sourceAnswerId !== null && item.targetAnswerId === null) {
    // Source has answer, target doesn't — adopt source answer
    return takeSourceAnswer(finalAnswers, qid, item.sourceAnswerId);
  }
  // Target has an answer (diff items require at least one side non-null and
  // the conflict/source-only branches are exhausted).
  return { cleared: 0, kept: 1, taken: 0 };
};

/** Apply all answer decisions — returns final answer map and summary counts */
const applyAnswerDecisions = async (
  targetId: number,
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): Promise<{
  finalAnswers: Map<number, number>;
  answersKept: number;
  answersTakenFromSource: number;
  answersCleared: number;
}> => {
  const targetAnswers = await getAttendeeAnswersByQuestion(targetId);

  // Start with target's answers as the base
  const finalAnswers = new Map<number, number>();
  for (const [qid, { answerId }] of targetAnswers) {
    finalAnswers.set(qid, answerId);
  }

  let answersKept = 0;
  let answersTakenFromSource = 0;
  let answersCleared = 0;

  for (const item of diff.answerItems) {
    const delta = applyAnswerDecision(item, decision, finalAnswers);
    answersKept += delta.kept;
    answersTakenFromSource += delta.taken;
    answersCleared += delta.cleared;
  }

  return { answersCleared, answersKept, answersTakenFromSource, finalAnswers };
};

/** Build an INSERT statement to copy a source booking to the target */
const bookingInsertStatement = (
  targetId: number,
  booking: ListingAttendeeRow,
): BatchStatement =>
  insert("listing_attendees", {
    attachment_downloads: booking.attachment_downloads,
    attendee_id: targetId,
    checked_in: booking.checked_in,
    end_at: booking.end_at,
    listing_id: booking.listing_id,
    order_token: booking.order_token,
    parent_listing_id: booking.parent_listing_id,
    price_paid: booking.price_paid,
    quantity: booking.quantity,
    refunded: booking.refunded,
    start_at: booking.start_at,
  }) as BatchStatement;

/** Apply all booking decisions — returns pending SQL statements and counts */
const applyBookingDecisions = (
  targetId: number,
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): {
  insertStatements: BatchStatement[];
  deleteTargetBookingStatements: BatchStatement[];
  bookingsMoved: number;
  bookingsSkipped: number;
  bookingsReplacedTarget: number;
} => {
  const insertStatements: BatchStatement[] = [];
  const deleteTargetBookingStatements: BatchStatement[] = [];
  let bookingsMoved = 0;
  let bookingsSkipped = 0;
  let bookingsReplacedTarget = 0;

  for (const item of diff.bookingItems) {
    const choice = decision.bookings[itemBookingKey(item)];

    if (item.conflictClass === "moveable") {
      // No conflict — move source booking to target
      insertStatements.push(
        bookingInsertStatement(targetId, item.sourceBooking),
      );
      bookingsMoved++;
    } else if (choice === "take_source" && item.targetBooking) {
      // Replace target booking with source booking
      deleteTargetBookingStatements.push({
        args: [targetId, item.listingId, item.startAt, item.startAt],
        sql: `DELETE FROM listing_attendees
              WHERE attendee_id = ? AND listing_id = ?
              AND (start_at IS ? OR start_at = ?)`,
      });
      insertStatements.push(
        bookingInsertStatement(targetId, item.sourceBooking),
      );
      bookingsReplacedTarget++;
    } else {
      // keep_target or skip_source — do nothing for this booking
      bookingsSkipped++;
    }
  }

  return {
    bookingsMoved,
    bookingsReplacedTarget,
    bookingsSkipped,
    deleteTargetBookingStatements,
    insertStatements,
  };
};

/** Apply a validated merge with explicit decisions */
export const applyAttendeeMerge = async (
  input: ApplyAttendeeMergeInput,
): Promise<AttendeeMergeApplyResult> => {
  const {
    targetId,
    sourceId,
    targetPii,
    sourcePii,
    diff,
    decision,
    privateKey,
  } = input;

  // --- 1. Apply PII decisions ---
  const { piiFieldsFromSource } = applyPiiDecisions(
    diff,
    decision,
    targetPii as Record<string, unknown>,
    sourcePii as Record<string, unknown>,
  );

  // --- 2. Apply answer decisions ---
  const { finalAnswers, answersKept, answersTakenFromSource, answersCleared } =
    await applyAnswerDecisions(targetId, diff, decision);

  // --- 3. Apply booking decisions ---
  const {
    insertStatements,
    deleteTargetBookingStatements,
    bookingsMoved,
    bookingsSkipped,
    bookingsReplacedTarget,
  } = applyBookingDecisions(targetId, diff, decision);

  // Free-text answers are not part of the merge diff UI. Load both attendees'
  // text answers BEFORE the batch below deletes the source's rows, then merge
  // them with the target taking precedence — so a source-only text answer is
  // adopted (matching how source-only choice answers are) instead of being
  // dropped, while a target answer is never silently overwritten.
  const [targetTextAnswers, sourceTextAnswers] = await Promise.all([
    getAttendeeTextAnswers(targetId, privateKey),
    getAttendeeTextAnswers(sourceId, privateKey),
  ]);
  const mergedTextAnswers = new Map([
    ...sourceTextAnswers,
    ...targetTextAnswers,
  ]);

  // --- 4. Execute all DB changes atomically ---
  await executeBatch([
    // Delete target bookings that are being replaced
    ...deleteTargetBookingStatements,
    // Insert moved/replaced source bookings
    ...insertStatements,
    // Clean up source attendee
    {
      args: [sourceId],
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
    },
    {
      args: [sourceId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    },
    {
      args: [sourceId],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    },
    { args: [sourceId], sql: "DELETE FROM attendees WHERE id = ?" },
  ]);

  // Save merged answers for target. The choice decisions reduce to one answer
  // per question; re-supplying the merged free-text plaintext lets
  // saveAttendeeAnswers' replace (delete-then-insert) re-create the encrypted
  // strings it drops instead of wiping the answers.
  await saveAttendeeAnswers(
    new Map([
      [
        targetId,
        {
          answerIds: [...finalAnswers.values()],
          textAnswers: [...mergedTextAnswers].map(([questionId, text]) => ({
            questionId,
            text,
          })),
        },
      ],
    ]),
  );

  const summary: AttendeeMergeApplySummary = {
    answersCleared,
    answersKept,
    answersTakenFromSource,
    bookingsMoved,
    bookingsReplacedTarget,
    bookingsSkipped,
    piiFieldsFromSource,
  };

  return { success: true, summary };
};
