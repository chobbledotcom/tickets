/** Diff behavior for the split attendee merge service test suite. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  buildMergeDiff,
  createMergePair,
  createQuestionWithAnswers,
  oneQuestion,
  saveChoice,
} from "./helpers.ts";

/** A created question paired with its answer rows. */
type QuestionSetup = Awaited<ReturnType<typeof createQuestionWithAnswers>>;

/** Build the diff for a pair that share a single choice question. */
const diffForQuestion = (
  source: Awaited<ReturnType<typeof createMergePair>>["source"],
  target: Awaited<ReturnType<typeof createMergePair>>["target"],
  question: QuestionSetup["question"],
  answers: QuestionSetup["answers"],
) =>
  buildMergeDiff({ questions: oneQuestion(question, answers), source, target });

/** Have the source attendee pick the second answer, then build the diff —
 *  the shared arrange behind the answer-conflict cases. */
const diffAfterSourceChoice = async (
  ...[source, target, question, answers]: Parameters<typeof diffForQuestion>
) => {
  await saveChoice(source.id, answers[1]!.id);
  return diffForQuestion(source, target, question, answers);
};

/** Assert the diff produced exactly one answer item and return it. */
const soleAnswerItem = (diff: Awaited<ReturnType<typeof diffForQuestion>>) => {
  expect(diff.answerItems.length).toBe(1);
  return diff.answerItems[0]!;
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("buildAttendeeMergeDiff", () => {
    test("detects PII diffs", async () => {
      const { source, target } = await createMergePair({ sameListing: true });

      const diff = await buildMergeDiff({ source, target });

      expect(diff.piiFields).toEqual([
        {
          field: "name",
          label: "Name",
          multiline: false,
          same: false,
          sourceValue: "Bob",
          targetValue: "Alice",
        },
        {
          field: "email",
          label: "Email",
          multiline: false,
          same: false,
          sourceValue: "bob@test.com",
          targetValue: "alice@test.com",
        },
        {
          field: "phone",
          label: "Phone",
          multiline: false,
          same: true,
          sourceValue: "",
          targetValue: "",
        },
        {
          field: "address",
          label: "Address",
          multiline: true,
          same: true,
          sourceValue: "",
          targetValue: "",
        },
        {
          field: "special_instructions",
          label: "Special Instructions",
          multiline: true,
          same: true,
          sourceValue: "",
          targetValue: "",
        },
      ]);
    });

    test("detects answer conflicts", async () => {
      const { listing, source, target } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Favourite colour?",
        ["Red", "Blue"],
      );

      await saveChoice(target.id, answers[0]!.id); // Red

      const diff = await diffAfterSourceChoice(
        source,
        target,
        question,
        answers,
      ); // source: Blue

      const item = soleAnswerItem(diff);
      expect(item.conflict).toBe(true);
      expect(item.questionText).toBe("Favourite colour?");
      expect(item.targetAnswerId).toBe(answers[0]!.id);
      expect(item.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("marks non-conflicting answers when only one has answer", async () => {
      const { listing, source, target } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["Small", "Large"],
      );

      // Only source has an answer
      const diff = await diffAfterSourceChoice(
        source,
        target,
        question,
        answers,
      );

      const item = soleAnswerItem(diff);
      expect(item.conflict).toBe(false);
      expect(item.targetAnswerId).toBeNull();
      expect(item.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("classifies bookings as moveable, duplicate, or conflicting", async () => {
      // target and source both sit on the same listing (a duplicate booking).
      const { source, target } = await createMergePair({ sameListing: true });
      // A second listing exists but the source isn't on it, so the diff still
      // sees exactly one (duplicate) booking to classify.
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      await bookAttendee(listing2, { email: "bob@test.com", name: "Bob" });

      const diff = await buildMergeDiff({ source, target });

      // Source has 1 booking that conflicts with target's on the same listing.
      expect(diff.bookingItems.length).toBe(1);
      // Both on same listing with same start_at (null) — duplicate
      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");
    });

    test("classifies as moveable when target has no booking at the source's key", async () => {
      // The default `createMergePair` puts the source on listing2 and target on
      // listing1, so the source booking has no twin to conflict with — the
      // conflict class is moveable.
      const { source, target } = await createMergePair();

      const diff = await buildMergeDiff({ source, target });

      expect(diff.bookingItems.length).toBe(1);
      // Source is on a listing the target doesn't have, so it can move.
      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");
      // A moveable booking's diff carries no sale amount (the booking moves
      // with its own money; only conflicts surface the at-stake amount).
      expect(diff.bookingItems[0]!.sourceSaleAmount).toBe(0);
    });

    test("includes version hash in diff", async () => {
      const { listing, source, target } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Pick one",
        ["A", "B"],
      );
      // And a second question the target answers, so the `ta:` fragment in
      // the version hash carries TWO comma-separated mappings — locking the
      // `,` separator inside joinMapped against the `, → ""` mutant (one
      // mapping alone wouldn't observe the join).
      const second = await createQuestionWithAnswers(
        listing.id,
        "Pick another",
        ["X", "Y"],
      );
      await saveChoice(target.id, answers[0]!.id);
      // Save the second choice alongside the first — `saveChoice` replaces the
      // attendee's full answer set, so re-save them together.
      const { saveAttendeeAnswers } = await import(
        "#db/questions/attendee-answers/save.ts"
      );
      await saveAttendeeAnswers(
        new Map([[target.id, [answers[0]!.id, second.answers[0]!.id]]]),
      );

      const diff = await buildMergeDiff({
        questions: [
          ...oneQuestion(question, answers),
          ...oneQuestion(second.question, second.answers),
        ],
        source,
        target,
      });

      const booking = bookingKey(listing.id, null, 0, 0);
      expect(diff.version).toBe(
        `t:${target.id}|s:${source.id}|ta:${question.id}=${answers[0]!.id},${second.question.id}=${second.answers[0]!.id}|sa:|tb:${booking}|sb:${booking}`,
      );
    });

    test("bookingSaleAmount counts only `sale` legs of one event group", async () => {
      // Source and target both sit on the same listing (a duplicate
      // conflict), so its diff's `sourceSaleAmount` is loaded via the
      // private `bookingSaleAmount` helper. The event group gets TWO legs:
      //   - a real sale leg: `attendee:source → revenue:listing` (kind=sale)
      //   - a phantom non-sale leg: `attendee:source → revenue:listing`
      //     (kind=payment) — same source/dest, wrong kind.
      // The filter rejects the phantom (its kind != KIND.sale), so the sale
      // amount must equal exactly the sale leg's amount (5000) — not 6234
      // (which it would be if any `&&` in the filter mutated to `||`) and
      // not 5001 (which it would be if the reduce's initial `0` mutated to
      // `1`). A single phantom covers all four `&& → ||` mutants because its
      // source/dest both match the filter — every mutant that turns one
      // `&&` into `||` lets it through.
      const { listing, source, target } = await createMergePair({
        sameListing: true,
      });
      const eventGroup = "evt-phantom-leg";
      const attendee = attendeeAccount(source.id);
      const revenue = revenueAccount(listing.id);
      await postTransfers([
        {
          amount: 5000,
          destination: revenue,
          eventGroup,
          kind: KIND.sale,
          occurredAt: "2026-06-21T00:00:00.000Z",
          reference: "phantom-sale",
          source: attendee,
        },
        {
          amount: 1234,
          destination: revenue,
          eventGroup,
          kind: KIND.payment,
          occurredAt: "2026-06-21T00:00:00.000Z",
          reference: "phantom-non-sale",
          source: attendee,
        },
      ]);
      await getDb().execute({
        args: [eventGroup, source.id, listing.id],
        sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
      });

      const diff = await buildMergeDiff({ source, target });

      // classifyBooking compares tb.price_paid vs sb.price_paid (both
      // ledger-fed), so posting the source's sale leg shifts source's
      // projected price_paid to 5000 while the target's stays 0 — that makes
      // the conflict class `conflicting_metadata`. Either conflict class
      // routes the booking through `bookingSaleAmount` (the moveable branch
      // skips it), so the kill is independent of which one fires.
      expect(diff.bookingItems[0]!.conflictClass).toBe("conflicting_metadata");
      expect(diff.bookingItems[0]!.sourceSaleAmount).toBe(5000);
    });

    test("a moveable booking's sale amounts stay 0 even when the source has a posted sale", async () => {
      // A moveable booking (target has no twin at the source's key) carries
      // its own money — its sale amount is hardcoded to 0 (line 350) and the
      // target's to 0 (line 358) since `tb` is null. To verify the moveable
      // short-circuit actually fires (and isn't accidentally bypassed —
      // e.g. by mutating the `moveable` literal to `""`, which would route
      // the moveable booking through `bookingSaleAmount` instead), post a
      // real sale leg onto a MOVEABLE source booking's event group: the diff
      // must STILL report 0 for both amounts.
      const { listing2, source, target } = await createMergePair();
      const eventGroup = "evt-moveable-sale";
      const attendee = attendeeAccount(source.id);
      const revenue = revenueAccount(listing2.id);
      await postTransfers([
        {
          amount: 5000,
          destination: revenue,
          eventGroup,
          kind: KIND.sale,
          occurredAt: "2026-06-21T00:00:00.000Z",
          reference: "moveable-sale",
          source: attendee,
        },
      ]);
      await getDb().execute({
        args: [eventGroup, source.id, listing2.id],
        sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
      });

      const diff = await buildMergeDiff({ source, target });

      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");
      expect(diff.bookingItems[0]!.sourceSaleAmount).toBe(0);
      expect(diff.bookingItems[0]!.targetSaleAmount).toBe(0);
    });
  });

  test("bookingKey distinguishes an empty-string start_at from a null one", () => {
    // `?? "null"` substitutes "null" only when startAt is nullish; an empty
    // string stays "". The `||` mutant would substitute "null" for "" too — so
    // this exact format on each case is what distinguishes ?? from ||.
    expect(bookingKey(1, "", 0, 0)).toBe("1::0:0");
    expect(bookingKey(1, null, 0, 0)).toBe("1:null:0:0");
    expect(bookingKey(2, "2026-06-21", 3, 4)).toBe("2:2026-06-21:3:4");
  });

  test("uses fallback question text for orphaned answers", async () => {
    const { listing, source, target } = await createMergePair({
      sameListing: true,
    });
    const q = await questionsTable.insert({
      displayType: "radio",
      text: "Hidden Q",
    });
    const a1 = await answersTable.insert({
      questionId: q.id,
      sortOrder: 0,
      text: "Yes",
    });
    await listingQuestions.setIds(listing.id, [q.id]);
    await saveChoice(source.id, a1.id);

    // Pass no questions — question text won't be found.
    const diff = await buildMergeDiff({ source, target });

    const answerItem = diff.answerItems.find((a) => a.questionId === q.id);
    expect(answerItem?.questionText).toBe(`Question #${q.id}`);
  });
});
