/**
 * Attendee merge service — single orchestration point for merge rules.
 *
 * Two-step flow:
 * 1. buildAttendeeMergeDiff: compute a diff between target and source
 * 2. applyAttendeeMerge: apply explicit decisions from the admin
 */

import type { InValue } from "@libsql/client";
import { filter, map, mapParallel, reduce } from "#fp";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { transfersByEventGroup } from "#shared/accounting/queries.ts";
import { repointAttendeeStatements } from "#shared/accounting/repoint.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { insert, withTransaction } from "#shared/db/client.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
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
  MergeBookingChoice,
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

/** The NON-moveable conflict booking items paired with their decision key
 *  ("listingId:startAt") — the rows the operator must decide on. The single place
 *  the "skip moveable rows, key the rest" walk lives, shared by validation, the
 *  decision-17 money legs, and the admin form parser, so they can never drift. */
export const conflictBookingEntries = (
  diff: AttendeeMergeDiff,
): Array<{ item: AttendeeMergeDiffBookingItem; key: string }> =>
  diff.bookingItems
    .filter((item) => item.conflictClass !== "moveable")
    .map((item) => ({ item, key: itemBookingKey(item) }));

/** Determine the conflict label for a non-moveable booking item */
export const bookingConflictLabel = (
  item: Pick<AttendeeMergeDiffBookingItem, "conflictClass">,
): string =>
  item.conflictClass === "duplicate" ? "Duplicate" : "Conflicting metadata";

/** Whether a set of booking items contains any non-moveable conflicts */
export const hasBookingConflicts = (
  items: Pick<AttendeeMergeDiffBookingItem, "conflictClass">[],
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
  const bookingItems = await buildBookingDiffItems(
    targetId,
    sourceId,
    targetBookings,
    sourceBookings,
  );

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

/**
 * One booking's recognised `sale` amount (its gross ticket price) in the ledger:
 * the `sale` legs of its order (`ledger_event_group`) that bill THIS attendee for
 * THIS listing. 0 for a free or pre-ledger booking. This is the money decision 17
 * has to resolve when the operator discards the booking — un-billing it removes
 * the double-counted income, and the same amount is the over-collected cash to
 * credit or write off.
 */
const bookingSaleAmount = async (
  attendeeId: number,
  listingId: number,
  eventGroup: string,
): Promise<number> => {
  if (!eventGroup) return 0;
  const account = attendeeAccount(attendeeId);
  const revenue = revenueAccount(listingId);
  const legs = await transfersByEventGroup(eventGroup);
  return legs
    .filter(
      (leg) =>
        leg.kind === "sale" &&
        leg.source.type === account.type &&
        leg.source.id === account.id &&
        leg.destination.type === revenue.type &&
        leg.destination.id === revenue.id,
    )
    .reduce((sum, leg) => sum + leg.amount, 0);
};

/** Classify a source booking against the target's bookings at the same key. */
const classifyBooking = (
  sb: ListingAttendeeRow,
  tb: ListingAttendeeRow | null,
): BookingConflictClass => {
  if (!tb) return "moveable";
  // `refunded` is now ledger-fed (order-level: every booking of an attendee
  // shares it), so this compares the target attendee's refund status against the
  // source's. Kept in the duplicate test so a row that differs only in refund
  // status is still surfaced as conflicting metadata, not a silent duplicate.
  if (
    tb.quantity === sb.quantity &&
    tb.price_paid === sb.price_paid &&
    tb.checked_in === sb.checked_in &&
    tb.refunded === sb.refunded
  ) {
    return "duplicate";
  }
  return "conflicting_metadata";
};

/** Build booking diff items comparing source bookings against target, loading the
 *  ledger `sale` amount for each conflict so decision 17 can require a money
 *  choice and the UI can show what is at stake. */
const buildBookingDiffItems = (
  targetId: number,
  sourceId: number,
  targetBookings: ListingAttendeeRow[],
  sourceBookings: ListingAttendeeRow[],
): Promise<AttendeeMergeDiffBookingItem[]> => {
  const targetByKey = new Map(
    map(
      (b: ListingAttendeeRow) =>
        [bookingKey(b.listing_id, b.start_at), b] as const,
    )(targetBookings),
  );

  return mapParallel(
    async (sb: ListingAttendeeRow): Promise<AttendeeMergeDiffBookingItem> => {
      const tb =
        targetByKey.get(bookingKey(sb.listing_id, sb.start_at)) ?? null;
      const conflictClass = classifyBooking(sb, tb);
      // A moveable booking moves with its own money (no decision, no
      // double-count); only a conflict needs the amounts at stake.
      const sourceSaleAmount =
        conflictClass === "moveable"
          ? 0
          : await bookingSaleAmount(
              sourceId,
              sb.listing_id,
              sb.ledger_event_group,
            );
      const targetSaleAmount =
        tb === null
          ? 0
          : await bookingSaleAmount(
              targetId,
              tb.listing_id,
              tb.ledger_event_group,
            );
      return {
        conflictClass,
        listingId: sb.listing_id,
        sourceBooking: sb,
        sourceSaleAmount,
        startAt: sb.start_at,
        targetBooking: tb,
        targetSaleAmount,
      };
    },
  )(sourceBookings);
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

  // Check booking decisions for conflicts — both the row choice AND, when the
  // booking the operator discards carries money, the decision-17 money choice
  // (credit vs write-off). Neither is ever defaulted silently.
  for (const { item, key } of conflictBookingEntries(diff)) {
    const label = `Listing #${item.listingId}${
      item.startAt ? ` (${item.startAt.slice(0, 10)})` : ""
    }`;
    const bookingChoice = decision.bookings[key];
    if (!bookingChoice) {
      errors.push(`Missing decision for booking: ${label}`);
      continue;
    }
    if (discardedSaleAmount(item, bookingChoice) > 0 && !decision.money[key]) {
      errors.push(`Missing money decision for booking: ${label}`);
    }
  }

  return errors.length > 0 ? { errors, valid: false } : { valid: true };
};

/** The `sale` amount the booking choice DISCARDS — the source booking for
 *  keep_target/skip_source, the target booking for take_source — so decision 17
 *  only demands a money choice when real money is being set aside. */
const discardedSaleAmount = (
  item: AttendeeMergeDiffBookingItem,
  bookingChoice: MergeBookingChoice,
): number => {
  if (bookingChoice === "take_source") return item.targetSaleAmount;
  return item.sourceSaleAmount;
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

/** Build an INSERT statement to copy a source booking to the target.
 *  `refunded` is not written — the column is gone; refund status follows the
 *  attendee through the merge's ledger repoint (the source's `refund_cash` legs
 *  are re-sourced onto the target), so the projection still reports it. The
 *  source's `ledger_event_group` IS carried: the repoint re-sources that booking's
 *  legs onto the target without changing their event group, so the copied row must
 *  keep the link or the per-row amount-paid projection loses it. */
const bookingInsertStatement = (
  targetId: number,
  booking: ListingAttendeeRow,
): BatchStatement =>
  insert("listing_attendees", {
    attachment_downloads: booking.attachment_downloads,
    attendee_id: targetId,
    checked_in: booking.checked_in,
    end_at: booking.end_at,
    ledger_event_group: booking.ledger_event_group,
    listing_id: booking.listing_id,
    order_token: booking.order_token,
    parent_listing_id: booking.parent_listing_id,
    quantity: booking.quantity,
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

/** One decision-17 reversal: a `writeoff` adjustment moving `account`'s balance
 *  by `delta` (credit-the-account terms). */
type MoneyReversal = {
  account: AccountRef;
  delta: number;
  keyParts: (string | number)[];
};

/**
 * Decision 17 — the `writeoff`-adjustment legs that resolve the money of each
 * CONFLICTING booking the operator discards. Both choices UN-BILL the discarded
 * `sale` (`revenue:L → writeoff`), so the listing's income counts the kept ticket
 * once instead of double-counting the duplicate; `credit` then hands the
 * over-collected cash back to the merged person (`writeoff → attendee:target`,
 * surfacing it as a credit), while `writeoff` leaves it parked in the contra
 * account so cash reports stay honest. Posted against the TARGET, onto which the
 * source's legs were just repointed. A free/0-amount conflict produces no legs.
 */
const moneyReversalLegs = (
  targetId: number,
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput,
): { legs: MoneyReversal[]; credited: number; writtenOff: number } => {
  const legs: MoneyReversal[] = [];
  let credited = 0;
  let writtenOff = 0;
  for (const { item, key } of conflictBookingEntries(diff)) {
    // Every conflict carries a booking choice by the time apply runs — the form
    // parser fills `keep_target` by default and validateAttendeeMergeDecision
    // rejects a missing one — so this read always resolves.
    const amount = discardedSaleAmount(item, decision.bookings[key]!);
    if (amount <= 0) continue;
    // Un-bill the discarded booking so the listing's income counts the kept ticket
    // once (revenue:L → writeoff).
    legs.push({
      account: revenueAccount(item.listingId),
      delta: -amount,
      keyParts: ["merge-unbill", targetId, key],
    });
    if (decision.money[key] === "credit") {
      // Hand the over-collected cash to the merged person (writeoff → attendee).
      legs.push({
        account: attendeeAccount(targetId),
        delta: amount,
        keyParts: ["merge-credit", targetId, key],
      });
      credited++;
    } else {
      writtenOff++;
    }
  }
  return { credited, legs, writtenOff };
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

  // --- 4. Resolve decision-17 money for the discarded conflicting bookings ---
  const {
    legs: moneyLegs,
    credited: bookingsCredited,
    writtenOff: bookingsWrittenOff,
  } = moneyReversalLegs(targetId, diff, decision);

  // --- 5. Execute all DB changes atomically ---
  // One interactive write transaction so the row changes, the ledger repoint, and
  // the decision-17 reversal legs commit or roll back together — a half-merge
  // would strand money or leave income double-counted.
  const rowStatements: { args: InValue[]; sql: string }[] = [
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
    // Move the source's ledger rows onto the target — the sole sanctioned
    // account-id mutation — so its financial history follows the merged person
    // rather than stranding on the deleted source (plan §5.17).
    ...repointAttendeeStatements(sourceId, targetId),
  ];
  await withTransaction(async (tx) => {
    for (const statement of rowStatements) await tx.execute(statement);
    // After the repoint (the discarded booking's legs now sit on the target),
    // post the reversal legs that un-bill it and credit / write off its cash.
    for (const leg of moneyLegs) {
      await ledgerTx.adjust(tx, leg.account, leg.delta, leg.keyParts);
    }
  });

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
    bookingsCredited,
    bookingsMoved,
    bookingsReplacedTarget,
    bookingsSkipped,
    bookingsWrittenOff,
    piiFieldsFromSource,
  };

  return { success: true, summary };
};
