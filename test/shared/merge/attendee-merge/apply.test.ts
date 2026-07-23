/** Apply behavior for the split attendee merge service test suite. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  eventGroup,
  legReference,
  type RefPart,
} from "#shared/accounting/refs.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import {
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";
import {
  applyMerge,
  bookingChoice,
  buildMergeDiff,
  createAttendee,
  createAttendeeOn,
  createFreeTextQuestion,
  createMergePair,
  createQuestionWithAnswers,
  getBookings,
  oneQuestion,
  pii,
  postPaidSale,
  runMerge,
  saveChoice,
  saveTextAnswer,
} from "./helpers.ts";

type MergePair = Awaited<ReturnType<typeof createMergePair>>;
/** A created question with its answer rows, as `createQuestionWithAnswers`
 *  returns — lets the helper signatures below name those fields without
 *  restating the helper's return shape. */
type QuestionSetup = Awaited<ReturnType<typeof createQuestionWithAnswers>>;

/** Merge `source` into `target` and assert the target ends up with `expected`
 *  as its free-text answer for `questionId`. */
const expectMergedTextAnswer = async (
  source: MergePair["source"],
  target: MergePair["target"],
  questionId: number,
  expected: string,
) => {
  const { result } = await runMerge({ source, target });
  expect(result.success).toBe(true);
  const textAnswers = await getAttendeeTextAnswers(
    target.id,
    await getTestPrivateKey(),
  );
  expect(textAnswers.get(questionId)).toBe(expected);
};

/** A summary on which the merge kept exactly one answer from the target (no
 *  take-source, no clear). The kept/taken/cleared counters shift under
 *  mutation of `applyAnswerDecision`'s kept-target arm (`return { cleared: 0,
 *  kept: 1, taken: 0 }` at line 538 or 546), `let answersKept = 0`, and the
 *  `answersKept += delta.kept` accumulator; the final-answers check pins the
 *  kept arm's value too. */
const expectKeptTargetAnswer = async (
  result: {
    success: boolean;
    summary: {
      answersKept: number;
      answersCleared: number;
      answersTakenFromSource: number;
    };
  },
  targetId: number,
  questionId: number,
  expectedAnswerId: number,
) => {
  expect(result.success).toBe(true);
  expect(result.summary.answersKept).toBe(1);
  expect(result.summary.answersCleared).toBe(0);
  expect(result.summary.answersTakenFromSource).toBe(0);
  const finalAnswers = await getAttendeeAnswersByQuestion(targetId);
  expect(finalAnswers.get(questionId)?.answerId).toBe(expectedAnswerId);
};

/** Save a target-Red / source-Blue conflict for the question: target picks
 *  answers[0], source picks answers[1]. Multiple apply tests set up the same
 *  2-sided conflict and then resolve it differently — the shared saveChoice
 *  pair lives here so the line-by-line duplication is hoisted out. */
const saveConflictAnswerChoice = async (
  target: MergePair["target"],
  source: MergePair["source"],
  answers: QuestionSetup["answers"],
) => {
  await saveChoice(target.id, answers[0]!.id);
  await saveChoice(source.id, answers[1]!.id);
};

/** Run the standard moveable source→target merge (`pii("Bob"…),
 *  pii("Alice"…)`) and return the booking row the source landed on the
 *  target — what `bookingInsertStatement` wrote. Shared by the no-quantity
 *  ghost test (cleared flag) and the real-quantity keep test (preserved
 *  flag), which assert against the returned row. */
const runMergeAndGetMovedBooking = async (
  source: MergePair["source"],
  target: MergePair["target"],
  sourceListingId: number,
) => {
  const { result } = await runMerge({
    source,
    sourcePii: pii("Bob", "b@test.com"),
    target,
    targetPii: pii("Alice", "a@test.com"),
  });
  expect(result.success).toBe(true);
  return (await getBookings(target.id)).find(
    (booking) => booking.listing_id === sourceListingId,
  )!;
};

/** Run a no-decisions merge (only the answer diff applies) and assert the
 *  target's single existing answer survived the merge unchanged. */
const mergeKeepingTargetAnswer = async (
  source: MergePair["source"],
  target: MergePair["target"],
  question: QuestionSetup["question"],
  answers: QuestionSetup["answers"],
  expectedAnswerId: number,
) => {
  const { result } = await runMerge({
    questions: oneQuestion(question, answers),
    source,
    target,
  });
  await expectKeptTargetAnswer(
    result,
    target.id,
    question.id,
    expectedAnswerId,
  );
};

/** Alice (target) and Bob (source) booked on a fresh 10-seat listing, with a
 *  paid sale on the source stamped into `eventGroup` — the shared arrange for
 *  the paid-conflict merge tests. `amount` defaults to postPaidSale's default. */
const paidSourceConflict = async (eventGroup: string, amount?: number) => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const target = await createAttendee(listing.id, "Alice", "a@test.com");
  const source = await createAttendee(listing.id, "Bob", "b@test.com");
  await postPaidSale({
    ...(amount === undefined ? {} : { amount }),
    attendeeId: source.id,
    eventGroup,
    listingId: listing.id,
  });
  await getDb().execute({
    args: [eventGroup, source.id, listing.id],
    sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
  });
  return { listing, source, target };
};

describeWithEnv("attendee merge service", { db: true }, () => {
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

      const moved = await runMergeAndGetMovedBooking(
        source,
        target,
        listing2.id,
      );
      expect(moved.quantity).toBe(0);
      // The ghost line arrives with its check-in cleared.
      expect(moved.checked_in).toBe(0);
    });

    test("applies PII and answer decisions correctly", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const { question, answers } = await createQuestionWithAnswers(
        listing1.id,
        "Colour?",
        ["Red", "Blue"],
      );

      const target = await createAttendee(
        listing1.id,
        "Alice",
        "alice@test.com",
      );
      const source = await createAttendee(listing2.id, "Bob", "bob@test.com");

      await saveChoice(target.id, answers[0]!.id); // Red
      await saveChoice(source.id, answers[1]!.id); // Blue

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "source" },
          bookings: {},
          money: {},
          pii: { email: "target", name: "source" },
        }),
        questions: oneQuestion(question, answers),
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
      const listingIds = listings.map((l) => l.id);
      const target = await createAttendeeOn(
        listingIds,
        "Alice",
        "alice@test.com",
      );
      const source = await createAttendeeOn(listingIds, "Bob", "bob@test.com");

      // Give every source booking a paid sale leg, so each same-listing duplicate
      // is a paid conflict that needs a money decision (a reversal leg on merge).
      for (let i = 0; i < N; i++) {
        await postPaidSale({
          attendeeId: source.id,
          eventGroup: `evt${i}`,
          listingId: listings[i]!.id,
        });
        // Link the booking row to its ledger event so the merge sees it as paid.
        await getDb().execute({
          args: [`evt${i}`, source.id, listings[i]!.id],
          sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
        });
      }

      const sourcePii = pii("Bob", "bob@test.com");
      const targetPii = pii("Alice", "alice@test.com");
      const diff = await buildMergeDiff({
        source,
        sourcePii,
        target,
        targetPii,
      });

      // Every listing is a duplicate conflict: keep the target row and write off
      // the discarded source booking's cash.
      const bookings: Record<string, "keep_target"> = {};
      const money: Record<string, "writeoff"> = {};
      for (const l of listings) {
        bookings[`${l.id}:null`] = "keep_target";
        money[`${l.id}:null`] = "writeoff";
      }

      const decision = {
        answers: {},
        bookings,
        money,
        pii: {},
        version: diff.version,
      };
      // Count how many DB round-trips the apply itself takes, ignoring setup.
      const { value: result, roundTrips } = await runAndCountRoundTrips(() =>
        applyMerge({ decision, diff, source, sourcePii, target, targetPii }),
      );

      expect(result.success).toBe(true);
      expect(result.summary.bookingsWrittenOff).toBe(N);
      // No `credit` decisions here, so the credited counter stays at 0 — this
      // distinguishes `let credited = 0` from `let credited = 1` (an off-by-one
      // mutant the writtenOff assertion alone wouldn't catch).
      expect(result.summary.bookingsCredited).toBe(0);
      // The N reversal legs land in one batch, so the merge's round-trips don't
      // scale with N (an interactive per-leg post would be ~3N and trip the guard).
      expect(roundTrips).toBeLessThanOrEqual(10);
    });

    test("credits the over-collected cash when a paid conflict is decided `credit`", async () => {
      // One duplicate booking that's paid on the SOURCE side: keep_target
      // discards the source's `sale`, and a `credit` money decision hands the
      // over-collected cash back to the merged attendee instead of writing it
      // off. This exercises moneyReversalLegs's `credit` arm: a second leg
      // posted to the attendee account, the `credited++` counter, and the
      // `delta: amount` sign — the kill for every line-specific mutant between
      // `let credited = 0` and `credited++`.
      const { listing, source, target } =
        await paidSourceConflict("credit-grp");

      const sourcePii = pii("Bob", "b@test.com");
      const targetPii = pii("Alice", "a@test.com");
      const diff = await buildMergeDiff({
        source,
        sourcePii,
        target,
        targetPii,
      });
      const key = bookingKey(listing.id, null, 0, 0);
      const decision = {
        answers: {},
        bookings: { [key]: "keep_target" as const },
        money: { [key]: "credit" as const },
        pii: {},
        version: diff.version,
      };

      const { result } = await runMerge({
        decide: () => decision,
        source,
        sourcePii,
        target,
        targetPii,
      });

      expect(result.success).toBe(true);
      // The credited counter increments once for the credit decision
      // (distinguishes `let credited = 0` from `let credited = 1` on the
      // no-money baseline above; distinguishes `credited++` from `--` here).
      expect(result.summary.bookingsCredited).toBe(1);
      expect(result.summary.bookingsWrittenOff).toBe(0);
      // The two legs — a negative revenue (un-bill) and a positive attendee
      // (credit) — both land under the merge-unbill / merge-credit key
      // prefixes. Inspect the attendee balance: the post-merge `credit-grp`
      // order reversed, leaving the merged attendee with cash parked as credit.
      const { transfersByAccount } = await import(
        "#shared/accounting/queries.ts"
      );
      const { attendeeAccount, revenueAccount } = await import(
        "#shared/accounting/accounts.ts"
      );
      const legs = await transfersByAccount(attendeeAccount(target.id));
      // The credit leg is positive (cash handed back to the attendee).
      const credit = legs.find(
        (leg) => leg.kind === "adjustment" && leg.amount > 0,
      );
      expect(credit).toBeDefined();
      // The un-bill reversal leg must land on the listing's revenue account
      // as source: `revenue → writeoff` (the original sale direction was
      // attendee → revenue, so un-billing it sources from revenue back out).
      // Removing the `legs.push` for the un-bill (line 712) leaves this leg
      // absent; mutating `-amount` to `+amount` (line 714) flips source and
      // destination (the writeoff→revenue credit doubles instead of un-bills).
      const revenueLegs = await transfersByAccount(revenueAccount(listing.id));
      const unbill = revenueLegs.find((leg) => leg.kind === "adjustment");
      expect(unbill).toBeDefined();
      expect(unbill!.source.type).toBe("revenue");
      expect(unbill!.destination.type).toBe("writeoff");
      expect(unbill!.amount).toBe(5000);
      const expectedIdentity = async (
        role: "merge-credit" | "merge-unbill",
        delta: number,
        occurredAt: string,
      ): Promise<{ eventGroup: string; reference: string }> => {
        const parts: RefPart[] = [role, target.id, key, delta, occurredAt];
        return {
          eventGroup: await eventGroup(parts),
          reference: await legReference(parts),
        };
      };
      expect({
        eventGroup: unbill!.eventGroup,
        reference: unbill!.reference,
      }).toEqual(
        await expectedIdentity("merge-unbill", -5000, unbill!.occurredAt),
      );
      expect({
        eventGroup: credit!.eventGroup,
        reference: credit!.reference,
      }).toEqual(
        await expectedIdentity("merge-credit", 5000, credit!.occurredAt),
      );
    });

    test("preserves the target's free-text answers through a merge", async () => {
      // Regression: the merge re-saves only the target's choice answers, which
      // deletes every attendee_answers row for the target. Without carrying the
      // free-text answers through, those text rows were silently wiped.
      const { target, source } = await createMergePair();
      const textQuestion = await createFreeTextQuestion();
      // The target owns the free-text answer that must survive the merge.
      await saveTextAnswer(target.id, textQuestion.id, "Coeliac");

      await expectMergedTextAnswer(source, target, textQuestion.id, "Coeliac");
    });

    test("adopts a source-only free-text answer in a merge", async () => {
      // Source-only choice answers are adopted automatically; a source-only
      // text answer must be too, rather than vanishing when the source is
      // deleted.
      const { target, source } = await createMergePair();
      const textQuestion = await createFreeTextQuestion();
      // Only the source owns the answer; the merge must adopt it, not drop it.
      await saveTextAnswer(source.id, textQuestion.id, "Vegan");

      await expectMergedTextAnswer(source, target, textQuestion.id, "Vegan");
    });

    test("clears answers when decision is clear", async () => {
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["S", "L"],
      );

      await saveConflictAnswerChoice(target, source, answers);

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "clear" },
          bookings: {},
          money: {},
          pii: {},
        }),
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      expect(result.summary.answersCleared).toBe(1);
      // The `clear` branch returns `{cleared:1, kept:0, taken:0}` — bumping
      // either 0 to 1 would slip past assertions on `answersCleared` alone,
      // so the `kept` and `taken` counts at 0 are what kill those mutants.
      expect(result.summary.answersKept).toBe(0);
      expect(result.summary.answersTakenFromSource).toBe(0);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(question.id)).toBe(false);
    });

    test("adopts source answers when target has none", async () => {
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Meal?",
        ["Chicken", "Fish"],
      );

      // Only source has answer
      await saveChoice(source.id, answers[1]!.id);

      const { result } = await runMerge({
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      expect(result.summary.answersTakenFromSource).toBe(1);
      // takeSourceAnswer returns `{cleared:0, kept:0, taken:1}` — mutating
      // its `cleared: 0` to `1` or `kept: 0` to `1` would bump these
      // counters, so asserting them at 0 is what kills those mutants.
      expect(result.summary.answersCleared).toBe(0);
      expect(result.summary.answersKept).toBe(0);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
    });

    test("handles duplicate booking with keep_target decision", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });

      const key = bookingKey(listing.id, null, 0, 0);
      const { diff, result } = await runMerge({
        decide: bookingChoice(key, "keep_target"),
        source,
        target,
      });

      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");
      expect(result.summary.bookingsSkipped).toBe(1);
      expect(result.summary.bookingsMoved).toBe(0);
      // The source booking carries no posted sale ledger, so moneyReversalLegs
      // records nothing for it: both counters stay at 0. A mutation that
      // bypasses the `if (!eventGroup) return 0` early-return (line 273) or
      // removes the `if (amount <= 0) continue` guard (line 709) would post a
      // bogus reversal leg here and bump one of the counters — catching it.
      expect(result.summary.bookingsWrittenOff).toBe(0);
      expect(result.summary.bookingsCredited).toBe(0);

      // Target still has exactly 1 booking
      const links = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
    });

    test("replaces target booking with take_source decision", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });

      // Update source booking to have different quantity to create conflicting_metadata
      await queryAll(
        "UPDATE listing_attendees SET quantity = 5 WHERE attendee_id = ?",
        [source.id],
      );

      const key = bookingKey(listing.id, null, 0, 0);
      const { diff, result } = await runMerge({
        decide: bookingChoice(key, "take_source"),
        source,
        target,
      });

      expect(diff.bookingItems[0]!.conflictClass).toBe("conflicting_metadata");
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
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const target = await createAttendee(listing1.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      const { diff, result } = await runMerge({
        decide: () => ({
          answers: {},
          bookings: {},
          money: {},
          pii: { name: "source" },
        }),
        source,
        target,
      });

      // Source is on listing2 only, target on listing1 — no conflicts, 1 moveable
      expect(diff.bookingItems.length).toBe(1);
      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");
      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.bookingsMoved).toBe(1);
      expect(result.summary.bookingsSkipped).toBe(0);
      expect(result.summary.bookingsReplacedTarget).toBe(0);
      // This test has no questions, so diff.answerItems is empty and the
      // accumulator `let answersKept = 0` is never incremented — its final
      // summary value must be 0. Mutating that init `0 → 1` shifts the
      // summary counter; the assertion fails (and similarly taken/cleared).
      expect(result.summary.answersKept).toBe(0);
      expect(result.summary.answersTakenFromSource).toBe(0);
      expect(result.summary.answersCleared).toBe(0);
    });

    test("writes off a discarded booking whose sale is exactly one minor unit", async () => {
      // The reversal guard is `if (amount <= 0) continue`; mutating `0 → 1`
      // makes it `amount <= 1`, which would silently skip a £0.01 (one
      // minor-unit) discarded booking — posting no reversal leg and keeping
      // the writtenOff counter at 0. A boundary-value £0.01 conflict is
      // what distinguishes `<= 0` from `<= 1`.
      const { listing, source, target } = await paidSourceConflict("evt-1p", 1);

      const key = bookingKey(listing.id, null, 0, 0);
      const { result } = await runMerge({
        decide: () => ({
          answers: {},
          bookings: { [key]: "keep_target" },
          money: { [key]: "writeoff" },
          pii: {},
        }),
        source,
        sourcePii: pii("Bob", "b@test.com"),
        target,
        targetPii: pii("Alice", "a@test.com"),
      });

      expect(result.success).toBe(true);
      expect(result.summary.bookingsWrittenOff).toBe(1);
      expect(result.summary.bookingsCredited).toBe(0);
    });

    test("preserves check-in when copying a positive-quantity source line", async () => {
      // bookingInsertStatement gates the copy's `checked_in` on
      // `booking.quantity > 0` (keep) vs `: 0` (clear, for ghost quantity-0
      // lines). Mutating `> 0` to `> 1` clears the flag on a quantity=1
      // moved line — so setting source's checked_in=1 and asserting the
      // moved booking keeps it is what kills the mutant.
      const { listing2, source, target } = await createMergePair();
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ?",
      });

      const moved = await runMergeAndGetMovedBooking(
        source,
        target,
        listing2.id,
      );
      expect(moved.quantity).toBe(1);
      // A real-quantity line keeps its check-in flag through the move.
      expect(moved.checked_in).toBe(1);
    });

    test("keeps the target's answer when the conflict decision is target", async () => {
      // Conflict question: target Red, source Blue. The default "target"
      // branch (line 538) returns `{cleared:0, kept:1, taken:0}`. Hitting
      // this branch kills every literal on that return value, AND
      // `let answersKept = 0 → 1` (init shifts the summary up by 1), AND
      // `answersKept += delta.kept → /= delta.kept` (mutated value 0/1=0
      // vs original 0+1=1). All observable through asserting the summary
      // kept-count ends at exactly 1.
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Colour?",
        ["Red", "Blue"],
      );
      await saveConflictAnswerChoice(target, source, answers);

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "target" },
          bookings: {},
          money: {},
          pii: {},
        }),
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      await expectKeptTargetAnswer(
        result,
        target.id,
        question.id,
        answers[0]!.id,
      );
    });

    test("keeps the target's answer when the source has none", async () => {
      // Non-conflict question where ONLY the target has answered. Original
      // logic skips the `sourceAnswerId !== null && targetAnswerId === null`
      // branch (source has no answer) and falls to line 546, returning
      // `{cleared:0, kept:1, taken:0}`. The kept-target arm at line 546 is
      // the second return mutated in this family — every literal on it
      // shifts a summary counter observable through the asserts.
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Snack?",
        ["Crisps", "Fruit"],
      );
      // Only the target answers — source's answerId stays null.
      await saveChoice(target.id, answers[0]!.id);
      await mergeKeepingTargetAnswer(
        source,
        target,
        question,
        answers,
        answers[0]!.id,
      );
    });

    test("keeps an agreed-upon answer the same on both sides", async () => {
      // Both target and source picked the SAME answer — so the diff item
      // has `conflict: false` BUT both `sourceAnswerId` and
      // `targetAnswerId` non-null. Line 540's guard
      // `sourceAnswerId !== null && targetAnswerId === null` is false (the
      // target side isn't null), so the original falls to line 546, returning
      // kept=1. Mutating `&& → ||` lets the guard fire here — calling
      // `takeSourceAnswer` instead and shifting kept:1 to taken:1. Asserting
      // the kept counter ends at exactly 1 (and taken at 0) is what kills it.
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Tea?",
        ["Yes", "No"],
      );
      await saveChoice(target.id, answers[0]!.id);
      await saveChoice(source.id, answers[0]!.id); // Same answer — no conflict
      await mergeKeepingTargetAnswer(
        source,
        target,
        question,
        answers,
        answers[0]!.id,
      );
    });
  });
});
