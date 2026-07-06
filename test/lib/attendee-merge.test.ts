import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import {
  createAttendeeAtomic,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  answersTable,
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  applyAttendeeMerge,
  bookingConflictLabel,
  bookingKey,
  buildAttendeeMergeDiff,
  hasBookingConflicts,
  nonConflictAnswerLabel,
  validateAttendeeMergeDecision,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
} from "#shared/merge/attendee-merge-types.ts";
import {
  bookAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { countRoundTrips } from "#test-utils/round-trips.ts";

/** One person in a merge: the attendee id plus the name/email that make up its
 *  PII, and (for a merge target) the encrypted ids the rebuilt blob needs. */
type MergeParty = {
  id: number;
  name: string;
  email: string;
  payment_id?: string;
  ticket_token?: string;
};

/** Create a test attendee directly via the DB, tagged with the name and email
 *  that form its PII so it can be passed straight into the merge helpers. */
const createAttendee = async (
  listingId: number,
  name = "Alice",
  email?: string,
  date?: string | null,
) => {
  const resolvedEmail = email ?? `${name.toLowerCase()}@test.com`;
  const result = await createAttendeeAtomic({
    bookings: [{ ...(date !== undefined ? { date } : {}), listingId }],
    email: resolvedEmail,
    name,
  });
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return { ...result.attendees[0]!, email: resolvedEmail, name };
};

/** Get bookings for an attendee — `refunded` is projected from the ledger, the
 *  same shape production's merge loader returns. */
const getBookings = (attendeeId: number) =>
  queryAll<{
    listing_id: number;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
    checked_in: number;
    refunded: number;
    price_paid: number;
    ledger_event_group: string;
    attachment_downloads: number;
    order_token: string;
    parent_listing_id: number;
    package_group_id: number;
  }>(
    `SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees
     WHERE attendee_id = ?
     ORDER BY start_at, listing_id`,
    [attendeeId],
  );

/** The target's booking row for a given listing after a merge (the moved leg). */
const findMovedBooking = async (targetId: number, listingId: number) =>
  (await getBookings(targetId)).find((b) => b.listing_id === listingId);

/** Create a question with answers and assign to listing */
const createQuestionWithAnswers = async (
  listingId: number,
  questionText: string,
  answerTexts: string[],
) => {
  const q = await questionsTable.insert({
    displayType: "radio",
    text: questionText,
  });
  const answers = [];
  for (let i = 0; i < answerTexts.length; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      sortOrder: i,
      text: answerTexts[i]!,
    });
    answers.push(a);
  }
  await setListingQuestions(listingId, [q.id]);
  return { answers, question: q };
};

/** Alice as the merge target and Bob as the merge source, each on the given
 *  listing (the pair almost every DB-backed merge test starts from). */
const aliceAndBob = async (
  targetListingId: number,
  sourceListingId: number,
) => {
  const target = await createAttendee(targetListingId, "Alice");
  const source = await createAttendee(sourceListingId, "Bob");
  return { source, target };
};

/** Two fresh listings named E1 and E2 — the target/source pair for a
 *  cross-listing merge. */
const eventListings = async () => ({
  listing1: await createTestListing({ maxAttendees: 10, name: "E1" }),
  listing2: await createTestListing({ maxAttendees: 10, name: "E2" }),
});

/** A default listing plus a second one named E2, for the free-text/answer
 *  merge tests where the target and source sit on different listings. */
const listingPlusE2 = async () => ({
  listing: await createTestListing({ maxAttendees: 10 }),
  listing2: await createTestListing({ maxAttendees: 10, name: "E2" }),
});

/** The PII block for a merge party — every field empty except name and email. */
const mergePii = (name: string, email: string) => ({
  address: "",
  email,
  name,
  phone: "",
  special_instructions: "",
});

/** A do-nothing merge decision (take every default) stamped with a version. */
const noChangeDecision = (version: string): AttendeeMergeDecisionInput => ({
  answers: {},
  bookings: {},
  money: {},
  pii: {},
  version,
});

/** Build the merge diff for a source→target pair, using each party's standard
 *  bookings and PII. */
const buildMergeDiff = async (
  source: MergeParty,
  target: MergeParty,
  questions: QuestionWithAnswers[] = [],
): Promise<AttendeeMergeDiff> =>
  buildAttendeeMergeDiff(
    {
      sourceBookings: await getBookings(source.id),
      sourceId: source.id,
      sourcePii: mergePii(source.name, source.email),
      targetBookings: await getBookings(target.id),
      targetId: target.id,
      targetPii: mergePii(target.name, target.email),
    },
    questions,
  );

/** Apply a merge of `source` into `target`. The decision defaults to "take
 *  every default"; pass one to override specific booking/answer/money/pii calls. */
const applyMerge = async ({
  decision,
  diff,
  source,
  target,
}: {
  diff: AttendeeMergeDiff;
  source: MergeParty;
  target: MergeParty;
  decision?: AttendeeMergeDecisionInput;
}) =>
  applyAttendeeMerge({
    decision: decision ?? noChangeDecision(diff.version),
    diff,
    privateKey: await getTestPrivateKey(),
    sourceId: source.id,
    sourcePii: mergePii(source.name, source.email),
    targetId: target.id,
    targetPii: {
      ...mergePii(target.name, target.email),
      payment_id: target.payment_id!,
      ticket_token: target.ticket_token!,
    },
  });

/** One listing, an Alice (target) / Bob (source) pair on it, and their merge
 *  diff — the simplest same-listing merge setup. */
const sameListingMergeDiff = async () => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const { source, target } = await aliceAndBob(listing.id, listing.id);
  const diff = await buildMergeDiff(source, target);
  return { diff, listing, source, target };
};

/** Build the diff for a source→target pair and apply the merge with the default
 *  (take-everything) decision, returning both. */
const mergeAndApply = async (
  source: MergeParty,
  target: MergeParty,
  questions: QuestionWithAnswers[] = [],
) => {
  const diff = await buildMergeDiff(source, target, questions);
  const result = await applyMerge({ diff, source, target });
  return { diff, result };
};

/** Two attendees to merge, a radio question on the target's listing, the target
 *  answering the first option and the source the second (a genuine conflict),
 *  and the merge diff carrying that question. */
const conflictingChoiceScenario = async (
  targetListingId: number,
  sourceListingId: number,
  questionText: string,
  options: string[],
) => {
  const { source, target } = await aliceAndBob(
    targetListingId,
    sourceListingId,
  );
  const { answers, question } = await createQuestionWithAnswers(
    targetListingId,
    questionText,
    options,
  );
  await saveAttendeeAnswers(new Map([[target.id, [answers[0]!.id]]]));
  await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));
  const diff = await buildMergeDiff(source, target, [{ ...question, answers }]);
  return { answers, diff, question, source, target };
};

/** Save `text` as a free-text "Dietary needs?" answer for `who`, merge the pair,
 *  and return the target's text answer for that question afterwards. Proves a
 *  target's own text survives and a source-only text is adopted. */
const mergedTextAnswer = async (
  who: "source" | "target",
  text: string,
): Promise<string | undefined> => {
  const { listing, listing2 } = await listingPlusE2();
  const textQuestion = await questionsTable.insert({
    displayType: "free_text",
    text: "Dietary needs?",
  });
  const { source, target } = await aliceAndBob(listing.id, listing2.id);
  const answerer = who === "target" ? target : source;
  await saveAttendeeAnswers(
    new Map([
      [
        answerer.id,
        { answerIds: [], textAnswers: [{ questionId: textQuestion.id, text }] },
      ],
    ]),
  );
  const { result } = await mergeAndApply(source, target);
  expect(result.success).toBe(true);
  return (
    await getAttendeeTextAnswers(target.id, await getTestPrivateKey())
  ).get(textQuestion.id);
};

/** A full listing-attendee booking row with sensible defaults, for the diff
 *  literals the decision-validation tests build by hand. Override only the
 *  columns a case cares about. */
const mergeBookingRow = (
  overrides: Partial<ListingAttendeeRow> = {},
): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  ledger_event_group: "",
  listing_id: 5,
  order_token: "",
  package_group_id: 0,
  parent_listing_id: 0,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...overrides,
});

/** A diff carrying a single booking conflict between source #2 and target #1 —
 *  the shape every decision-validation test starts from. */
const oneBookingConflictDiff = (
  bookingItem: AttendeeMergeDiff["bookingItems"][number],
): AttendeeMergeDiff => ({
  answerItems: [],
  bookingItems: [bookingItem],
  piiFields: [],
  sourceId: 2,
  targetId: 1,
  version: "v1",
});

/** The recurring "Colour?" answer conflict (target Red, source Blue). */
const colourAnswerConflict = () => ({
  conflict: true as const,
  questionId: 10,
  questionText: "Colour?",
  sourceAnswerId: 2,
  sourceAnswerText: "Blue",
  targetAnswerId: 1,
  targetAnswerText: "Red",
});

/** A single same-listing booking conflict item (source #2 → target #1), listing
 *  #5, with sensible defaults. Override just the columns a case cares about. */
const bookingConflict = (
  overrides: Partial<AttendeeMergeDiff["bookingItems"][number]> = {},
): AttendeeMergeDiff["bookingItems"][number] => ({
  conflictClass: "duplicate",
  listingId: 5,
  parentListingId: 0,
  sourceBooking: mergeBookingRow(),
  sourceSaleAmount: 0,
  startAt: null,
  targetBooking: null,
  targetSaleAmount: 0,
  ...overrides,
});

/** A diff whose only answer item is the "Colour?" conflict, with the given
 *  booking items (none by default). */
const answerConflictDiff = (
  bookingItems: AttendeeMergeDiff["bookingItems"] = [],
): AttendeeMergeDiff => ({
  answerItems: [colourAnswerConflict()],
  bookingItems,
  piiFields: [],
  sourceId: 2,
  targetId: 1,
  version: "v1",
});

/** A merge decision that starts from "take every default" and applies the given
 *  overrides (stamped with the diff's version). */
const decisionFor = (
  diff: AttendeeMergeDiff,
  overrides: Partial<AttendeeMergeDecisionInput> = {},
): AttendeeMergeDecisionInput => ({
  ...noChangeDecision(diff.version),
  ...overrides,
});

/** Validate a decision that must be REJECTED, returning the error messages. */
const rejectionErrors = (
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput = noChangeDecision(diff.version),
): string[] => {
  const result = validateAttendeeMergeDecision(diff, decision);
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.errors;
};

/** Assert a decision is accepted (valid). */
const expectAccepted = (
  diff: AttendeeMergeDiff,
  decision: AttendeeMergeDecisionInput = noChangeDecision(diff.version),
): void => {
  expect(validateAttendeeMergeDecision(diff, decision).valid).toBe(true);
};

describeWithEnv("attendee merge service", { db: true }, () => {
  test("repoints the source's ledger rows onto the target", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });
    const { source, target } = await aliceAndBob(listing1.id, listing2.id);

    // A paid booking on the source attendee, recorded in the ledger.
    await postTransfers([
      {
        amount: 5000,
        destination: revenueAccount(listing2.id),
        eventGroup: "evt",
        kind: "sale",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "sale",
        source: attendeeAccount(source.id),
      },
      {
        amount: 5000,
        destination: attendeeAccount(source.id),
        eventGroup: "evt",
        kind: "payment",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "pay",
        source: WORLD,
      },
    ]);

    const { result } = await mergeAndApply(source, target);

    expect(result.success).toBe(true);
    // The source's legs now belong to the target; nothing strands on the
    // deleted source attendee.
    expect((await transfersByAccount(attendeeAccount(source.id))).length).toBe(
      0,
    );
    expect((await transfersByAccount(attendeeAccount(target.id))).length).toBe(
      2,
    );
  });

  test("preserves package_group_id when moving a source package booking", async () => {
    const group = await createTestGroup({ isPackage: true, name: "MergePkg" });
    const targetListing = await createTestListing({ maxAttendees: 10 });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });
    const target = await createAttendee(
      targetListing.id,
      "Alice",
      "alice@test.com",
    );
    const sourceResult = await createAttendeeAtomic({
      bookings: [{ listingId: member.id }],
      email: "bob@test.com",
      name: "Bob",
      packageGroupId: group.id,
    });
    if (!sourceResult.success) throw new Error("source booking failed");
    const source = {
      ...sourceResult.attendees[0]!,
      email: "bob@test.com",
      name: "Bob",
    };

    const { result } = await mergeAndApply(source, target);

    expect(result.success).toBe(true);
    // The moved package booking keeps its group, so the merged attendee's
    // ticket still renders/hides as the package rather than a bare listing.
    const moved = await findMovedBooking(target.id, member.id);
    expect(moved?.package_group_id).toBe(group.id);
  });

  describe("bookingKey", () => {
    test("formats key with start_at", () => {
      expect(bookingKey(1, "2026-05-01", 0)).toBe("1:2026-05-01:0");
    });

    test("formats key with null start_at", () => {
      expect(bookingKey(1, null, 0)).toBe("1:null:0");
    });

    test("distinguishes rows by parent_listing_id", () => {
      expect(bookingKey(5, null, 1)).toBe("5:null:1");
      expect(bookingKey(5, null, 2)).toBe("5:null:2");
    });
  });

  describe("nonConflictAnswerLabel", () => {
    test("returns target label when target has answer", () => {
      const item = {
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: null,
        sourceAnswerText: null,
        targetAnswerId: 10,
        targetAnswerText: "Red",
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Red",
        from: "target",
      });
    });

    test("returns source label when only source has answer", () => {
      const item = {
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: 20,
        sourceAnswerText: "Water",
        targetAnswerId: null,
        targetAnswerText: null,
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Water",
        from: "source",
      });
    });
  });

  describe("bookingConflictLabel", () => {
    test("returns Duplicate for duplicate conflict class", () => {
      const item = {
        conflictClass: "duplicate" as const,
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Duplicate");
    });

    test("returns Conflicting metadata for conflicting_metadata class", () => {
      const item = {
        conflictClass: "conflicting_metadata" as const,
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Conflicting metadata");
    });
  });

  describe("hasBookingConflicts", () => {
    test("returns false when all items are moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(false);
    });

    test("returns true when at least one item is not moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
        {
          conflictClass: "duplicate" as const,
          listingId: 2,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(true);
    });
  });

  describe("buildAttendeeMergeDiff", () => {
    test("detects PII diffs", async () => {
      const { diff } = await sameListingMergeDiff();

      expect(diff.piiFields.length).toBe(5);
      const nameField = diff.piiFields.find((f) => f.field === "name")!;
      expect(nameField.same).toBe(false);
      expect(nameField.targetValue).toBe("Alice");
      expect(nameField.sourceValue).toBe("Bob");

      // phone/address/special_instructions are same (both empty)
      const phoneField = diff.piiFields.find((f) => f.field === "phone")!;
      expect(phoneField.same).toBe(true);
    });

    test("detects answer conflicts", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { answers, diff } = await conflictingChoiceScenario(
        listing.id,
        listing.id,
        "Favourite colour?",
        ["Red", "Blue"],
      );

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(true);
      expect(diff.answerItems[0]!.questionText).toBe("Favourite colour?");
      expect(diff.answerItems[0]!.targetAnswerId).toBe(answers[0]!.id);
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("marks non-conflicting answers when only one has answer", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["Small", "Large"],
      );

      const { source, target } = await aliceAndBob(listing.id, listing.id);

      // Only source has an answer
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));

      const diff = await buildMergeDiff(source, target, [
        { ...question, answers },
      ]);

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(false);
      expect(diff.answerItems[0]!.targetAnswerId).toBeNull();
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("classifies bookings as moveable, duplicate, or conflicting", async () => {
      const { listing1, listing2 } = await eventListings();

      const { source, target } = await aliceAndBob(listing1.id, listing1.id);
      // Add source to listing2 as well
      await bookAttendee(listing2, { email: "bob@test.com", name: "Bob" });
      // But for this test, let's use direct attendees
      // target is on listing1, source is on listing1 (duplicate) and listing2 (moveable)

      const diff = await buildMergeDiff(source, target);

      // Source has 1 booking (listing1) that conflicts with target's listing1
      expect(diff.bookingItems.length).toBe(1);
      // Both on same listing with same start_at (null) — duplicate
      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");
    });

    test("includes version hash in diff", async () => {
      const { diff } = await sameListingMergeDiff();

      expect(diff.version).toBeTruthy();
      expect(typeof diff.version).toBe("string");
    });
  });

  test("uses fallback question text for orphaned answers", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const q = await questionsTable.insert({
      displayType: "radio",
      text: "Hidden Q",
    });
    const a1 = await answersTable.insert({
      questionId: q.id,
      sortOrder: 0,
      text: "Yes",
    });
    await setListingQuestions(listing.id, [q.id]);

    const { source, target } = await aliceAndBob(listing.id, listing.id);
    await saveAttendeeAnswers(new Map([[source.id, [a1.id]]]));

    // Pass empty questions array — question text won't be found
    const diff = await buildMergeDiff(source, target);

    const answerItem = diff.answerItems.find((a) => a.questionId === q.id);
    expect(answerItem?.questionText).toBe(`Question #${q.id}`);
  });

  describe("validateAttendeeMergeDecision", () => {
    test("rejects stale version", () => {
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(
        diff,
        noChangeDecision("v2"),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("out of date");
      }
    });

    test("rejects missing answer decision for conflict", () => {
      const errors = rejectionErrors(answerConflictDiff());
      expect(errors[0]).toContain("Colour?");
    });

    test("rejects missing booking decision for conflict", () => {
      const diff = oneBookingConflictDiff(
        bookingConflict({
          conflictClass: "conflicting_metadata",
          targetBooking: mergeBookingRow({ quantity: 2 }),
        }),
      );
      expect(rejectionErrors(diff)[0]).toContain("Listing #5");
    });

    test("rejects missing booking decision for daily listing conflict", () => {
      const diff = oneBookingConflictDiff(
        bookingConflict({
          listingId: 7,
          sourceBooking: mergeBookingRow({
            listing_id: 7,
            start_at: "2026-06-15T10:00:00Z",
          }),
          startAt: "2026-06-15T10:00:00Z",
          targetBooking: mergeBookingRow({
            listing_id: 7,
            quantity: 2,
            start_at: "2026-06-15T10:00:00Z",
          }),
        }),
      );
      expect(rejectionErrors(diff)[0]).toContain("2026-06-15");
    });

    test("rejects copying a no-quantity source line that still carries a payment", () => {
      // A quantity-0 line must have price_paid = 0; merging one that doesn't
      // would strand the charge behind the quantity-0 refund guards.
      const diff = oneBookingConflictDiff(
        bookingConflict({
          conflictClass: "moveable",
          sourceBooking: mergeBookingRow({ price_paid: 1500, quantity: 0 }),
          sourceSaleAmount: 1500,
        }),
      );
      expect(
        rejectionErrors(diff).some((e) =>
          e.includes("strand a recorded payment"),
        ),
      ).toBe(true);
    });

    test("rejects replacing an active paid target line with a no-quantity source", () => {
      // take_source would delete the paid target and insert the quantity-0
      // source, stranding the target's payment behind a ghost row.
      const diff = oneBookingConflictDiff(
        bookingConflict({
          conflictClass: "conflicting_metadata",
          sourceBooking: mergeBookingRow({ quantity: 0 }),
          targetBooking: mergeBookingRow({ price_paid: 1500, quantity: 2 }),
          targetSaleAmount: 1500,
        }),
      );
      const errors = rejectionErrors(
        diff,
        decisionFor(diff, { bookings: { "5:null:0": "take_source" } }),
      );
      expect(errors.some((e) => e.includes("strand a recorded payment"))).toBe(
        true,
      );
    });

    test("allows moving a no-quantity source line that carries no payment", () => {
      // A clean quantity-0 sentinel (no payment, no paid target) is moveable.
      const diff = oneBookingConflictDiff(
        bookingConflict({
          conflictClass: "moveable",
          sourceBooking: mergeBookingRow({ quantity: 0 }),
        }),
      );
      expectAccepted(diff);
    });

    test("accepts valid decisions", () => {
      const diff = answerConflictDiff([
        bookingConflict({ targetBooking: mergeBookingRow({ quantity: 2 }) }),
      ]);
      expectAccepted(diff, {
        answers: { "10": "source" },
        bookings: { "5:null:0": "keep_target" },
        money: {},
        pii: { name: "target" },
        version: "v1",
      });
    });

    // --- Decision 17: a discarded booking that carries money needs a choice --- //

    /** A single same-listing duplicate conflict carrying the given ledger sale
     *  amounts on each side. */
    const moneyConflictDiff = (
      sourceSaleAmount: number,
      targetSaleAmount: number,
    ): AttendeeMergeDiff => {
      const paidRow = mergeBookingRow({
        ledger_event_group: "grp",
        price_paid: 5000,
      });
      return oneBookingConflictDiff(
        bookingConflict({
          sourceBooking: paidRow,
          sourceSaleAmount,
          targetBooking: paidRow,
          targetSaleAmount,
        }),
      );
    };

    const decisionWith = (
      money: AttendeeMergeDecisionInput["money"],
      booking: "keep_target" | "take_source" = "keep_target",
    ): AttendeeMergeDecisionInput => ({
      answers: {},
      bookings: { "5:null:0": booking },
      money,
      pii: {},
      version: "v1",
    });

    test("rejects a discarded paid booking with no money decision", () => {
      // keep_target discards the SOURCE booking (£50 of recognised sale), so the
      // operator must choose credit vs write-off — never a silent default.
      const errors = rejectionErrors(
        moneyConflictDiff(5000, 5000),
        decisionWith({}),
      );
      expect(errors[0]).toContain("money decision");
    });

    test("accepts a discarded paid booking once a money choice is given", () => {
      expectAccepted(
        moneyConflictDiff(5000, 5000),
        decisionWith({ "5:null:0": "credit" }),
      );
    });

    test("needs no money decision when the discarded booking is free", () => {
      // A £0 conflict carries no money, so only the row choice is required.
      expectAccepted(moneyConflictDiff(0, 0), decisionWith({}));
    });

    test("take_source weighs the TARGET amount it discards, not the source", () => {
      // Replacing with the source discards the TARGET booking; its £50 is what
      // needs a decision even though the source booking is free.
      const errors = rejectionErrors(
        moneyConflictDiff(0, 5000),
        decisionWith({}, "take_source"),
      );
      expect(errors[0]).toContain("money decision");
    });
  });

  describe("applyAttendeeMerge", () => {
    test("clears check-in when copying a no-quantity source line", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "M1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "M2",
      });
      const target = await createAttendee(listing1.id, "Alice", "a@test.com");
      const source = await createAttendee(listing2.id, "Bob", "b@test.com");
      // Make source's line a checked-in quantity-0 sentinel (price 0).
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET quantity = 0, checked_in = 1 WHERE attendee_id = ?",
      });

      const { result } = await mergeAndApply(source, target);
      expect(result.success).toBe(true);

      const moved = (await findMovedBooking(target.id, listing2.id))!;
      expect(moved.quantity).toBe(0);
      // The ghost line arrives with its check-in cleared.
      expect(moved.checked_in).toBe(0);
    });

    test("applies PII and answer decisions correctly", async () => {
      const { listing1, listing2 } = await eventListings();

      const { answers, diff, question, source, target } =
        await conflictingChoiceScenario(listing1.id, listing2.id, "Colour?", [
          "Red",
          "Blue",
        ]);

      const result = await applyMerge({
        decision: decisionFor(diff, {
          answers: { [String(question.id)]: "source" },
          pii: { email: "target", name: "source" },
        }),
        diff,
        source,
        target,
      });

      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.answersTakenFromSource).toBe(1);
      expect(result.summary.bookingsMoved).toBe(1); // listing2 moved to target

      // Verify answers were updated
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);

      // Verify source deleted
      const sourceRows = await queryAll<{ id: number }>(
        "SELECT id FROM attendees WHERE id = ?",
        [source.id],
      );
      expect(sourceRows.length).toBe(0);

      // Verify target has both listing links
      const listingLinks = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(listingLinks.map((r) => r.listing_id).sort()).toEqual(
        [listing1.id, listing2.id].sort(),
      );
    });

    test("merges many paid duplicate bookings in a bounded number of round-trips", async () => {
      // Regression: each discarded paid booking posts a decision-17 reversal leg.
      // Posting them one-leg-at-a-time inside an interactive transaction held the
      // write lock open for several round-trips PER leg, so a big merge could blow
      // the primary's transaction timeout. The whole merge must commit as one batch
      // — O(1) round-trips regardless of how many bookings the person has.
      const N = 12;
      // Sequential: each createTestListing runs an authenticated request that
      // mints a session, so building them concurrently would collide session
      // tokens — the round-trip count we assert on is the merge, not the setup.
      const listings: Awaited<ReturnType<typeof createTestListing>>[] = [];
      for (let i = 0; i < N; i++) {
        listings.push(await createTestListing({ maxAttendees: 10 }));
      }
      const at = "2026-06-21T00:00:00.000Z";
      const book = async (name: string, email: string) => {
        const r = await createAttendeeAtomic({
          bookings: listings.map((l) => ({ listingId: l.id })),
          email,
          name,
        });
        if (!r.success) throw new Error("setup failed");
        return { ...r.attendees[0]!, email, name };
      };
      const target = await book("Alice", "alice@test.com");
      const source = await book("Bob", "bob@test.com");

      // Give every source booking a paid sale leg, so each same-listing duplicate
      // is a paid conflict that needs a money decision (a reversal leg on merge).
      for (let i = 0; i < N; i++) {
        await postTransfers([
          {
            amount: 5000,
            destination: revenueAccount(listings[i]!.id),
            eventGroup: `evt${i}`,
            kind: "sale",
            occurredAt: at,
            reference: `sale${i}`,
            source: attendeeAccount(source.id),
          },
          {
            amount: 5000,
            destination: attendeeAccount(source.id),
            eventGroup: `evt${i}`,
            kind: "payment",
            occurredAt: at,
            reference: `pay${i}`,
            source: WORLD,
          },
        ]);
        // Link the booking row to its ledger event so the merge sees it as paid.
        await getDb().execute({
          args: [`evt${i}`, source.id, listings[i]!.id],
          sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
        });
      }

      const diff = await buildMergeDiff(source, target);

      // Every listing is a duplicate conflict: keep the target row and write off
      // the discarded source booking's cash.
      const bookings: Record<string, "keep_target"> = {};
      const money: Record<string, "writeoff"> = {};
      for (const l of listings) {
        bookings[`${l.id}:null`] = "keep_target";
        money[`${l.id}:null`] = "writeoff";
      }

      const { result, roundTrips } = await countRoundTrips(() =>
        applyMerge({
          decision: decisionFor(diff, { bookings, money }),
          diff,
          source,
          target,
        }),
      );

      expect(result.success).toBe(true);
      expect(result.summary.bookingsWrittenOff).toBe(N);
      // The N reversal legs land in one batch, so the merge's round-trips don't
      // scale with N (an interactive per-leg post would be ~3N and trip the guard).
      expect(roundTrips).toBeLessThanOrEqual(10);
    });

    test("preserves the target's free-text answers through a merge", async () => {
      // Regression: the merge re-saves only the target's choice answers, which
      // deletes every attendee_answers row for the target. Without carrying the
      // free-text answers through, those text rows were silently wiped.
      expect(await mergedTextAnswer("target", "Coeliac")).toBe("Coeliac");
    });

    test("adopts a source-only free-text answer in a merge", async () => {
      // Source-only choice answers are adopted automatically; a source-only
      // text answer must be too, rather than vanishing when the source is
      // deleted.
      expect(await mergedTextAnswer("source", "Vegan")).toBe("Vegan");
    });

    test("clears answers when decision is clear", async () => {
      const { listing, listing2 } = await listingPlusE2();
      const { diff, question, source, target } =
        await conflictingChoiceScenario(listing.id, listing2.id, "Size?", [
          "S",
          "L",
        ]);

      const result = await applyMerge({
        decision: decisionFor(diff, {
          answers: { [String(question.id)]: "clear" },
        }),
        diff,
        source,
        target,
      });

      expect(result.summary.answersCleared).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(question.id)).toBe(false);
    });

    test("adopts source answers when target has none", async () => {
      const { listing, listing2 } = await listingPlusE2();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Meal?",
        ["Chicken", "Fish"],
      );

      const { source, target } = await aliceAndBob(listing.id, listing2.id);

      // Only source has answer
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));

      const { result } = await mergeAndApply(source, target, [
        { ...question, answers },
      ]);

      expect(result.summary.answersTakenFromSource).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
    });

    test("handles duplicate booking with keep_target decision", async () => {
      const { diff, listing, source, target } = await sameListingMergeDiff();

      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");

      const key = bookingKey(listing.id, null, 0);
      const result = await applyMerge({
        decision: decisionFor(diff, { bookings: { [key]: "keep_target" } }),
        diff,
        source,
        target,
      });

      expect(result.summary.bookingsSkipped).toBe(1);
      expect(result.summary.bookingsMoved).toBe(0);

      // Target still has exactly 1 booking
      const links = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
    });

    test("replaces target booking with take_source decision", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const { source, target } = await aliceAndBob(listing.id, listing.id);

      // Update source booking to have different quantity to create conflicting_metadata
      await queryAll(
        "UPDATE listing_attendees SET quantity = 5 WHERE attendee_id = ?",
        [source.id],
      );

      const diff = await buildMergeDiff(source, target);

      expect(diff.bookingItems[0]!.conflictClass).toBe("conflicting_metadata");

      const key = bookingKey(listing.id, null, 0);
      const result = await applyMerge({
        decision: decisionFor(diff, { bookings: { [key]: "take_source" } }),
        diff,
        source,
        target,
      });

      expect(result.summary.bookingsReplacedTarget).toBe(1);

      // Target's booking should now have qty 5
      const links = await queryAll<{ quantity: number }>(
        `SELECT quantity
         FROM listing_attendees
         WHERE attendee_id = ?
           AND listing_id = ?`,
        [target.id, listing.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.quantity).toBe(5);
    });

    test("returns accurate summary counts", async () => {
      const { listing1, listing2 } = await eventListings();

      const { source, target } = await aliceAndBob(listing1.id, listing2.id);

      const diff = await buildMergeDiff(source, target);

      // Source is on listing2 only, target on listing1 — no conflicts, 1 moveable
      expect(diff.bookingItems.length).toBe(1);
      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");

      const result = await applyMerge({
        decision: decisionFor(diff, { pii: { name: "source" } }),
        diff,
        source,
        target,
      });

      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.bookingsMoved).toBe(1);
      expect(result.summary.bookingsSkipped).toBe(0);
      expect(result.summary.bookingsReplacedTarget).toBe(0);
    });
  });
});
