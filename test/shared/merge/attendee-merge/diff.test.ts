import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { bookingKey } from "#shared/merge/attendee-merge.ts";
import { bookAttendee, createTestListing, describeWithEnv } from "#test-utils";
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

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("buildAttendeeMergeDiff", () => {
    test("detects PII diffs", async () => {
      const { source, target } = await createMergePair({ sameListing: true });

      const diff = await buildMergeDiff({ source, target });

      // The full PII field schema (label + multiline flag for each), so a
      // mutant that drops a label or flips a multiline flag is caught here.
      expect(diff.piiFields).toEqual([
        expect.objectContaining({
          field: "name",
          label: "Name",
          multiline: false,
        }),
        expect.objectContaining({
          field: "email",
          label: "Email",
          multiline: false,
        }),
        expect.objectContaining({
          field: "phone",
          label: "Phone",
          multiline: false,
        }),
        expect.objectContaining({
          field: "address",
          label: "Address",
          multiline: true,
        }),
        expect.objectContaining({
          field: "special_instructions",
          label: "Special Instructions",
          multiline: true,
        }),
      ]);
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
      const { listing, source, target } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Favourite colour?",
        ["Red", "Blue"],
      );

      await saveChoice(target.id, answers[0]!.id); // Red
      await saveChoice(source.id, answers[1]!.id); // Blue

      const diff = await diffForQuestion(source, target, question, answers);

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(true);
      expect(diff.answerItems[0]!.questionText).toBe("Favourite colour?");
      expect(diff.answerItems[0]!.targetAnswerId).toBe(answers[0]!.id);
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
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
      await saveChoice(source.id, answers[1]!.id);

      const diff = await diffForQuestion(source, target, question, answers);

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(false);
      expect(diff.answerItems[0]!.targetAnswerId).toBeNull();
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
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
        "#shared/db/questions.ts"
      );
      await saveAttendeeAnswers(
        new Map([
          [target.id, [answers[0]!.id, second.answers[0]!.id]],
        ]),
      );

      const diff = await buildMergeDiff({
        questions: [
          ...oneQuestion(question, answers),
          ...oneQuestion(second.question, second.answers),
        ],
        source,
        target,
      });

      expect(diff.version).toBeTruthy();
      expect(typeof diff.version).toBe("string");
      // The version string prefix-lists the four sections in order, joined by
      // "|", and each section's tag (t:/s:/ta:/sa:/tb:/sb:) only appears once.
      expect(diff.version).toMatch(/^t:\d+\|s:\d+/);
      // The target's answer-id mapping travels inside `ta:` as
      // `<questionId>=<answerId>` — its presence locks the comma separator AND
      // both indexes (key vs answer value) against mutation. The second
      // mapping forces a comma between the two `<qid>=<aid>` fragments.
      expect(diff.version).toContain(`ta:${question.id}=${answers[0]!.id}`);
      expect(diff.version).toContain(
        `${second.question.id}=${second.answers[0]!.id}`,
      );
      // Two saved answers => a comma-joined `ta:` fragment. The exact form is
      // one of two orderings depending on the answers' query order, but
      // either way the comma sits between the two `id=aid` fragments.
      const taFragment = diff.version.split("ta:")[1]!.split("|")[0]!;
      expect(taFragment).toContain(",");
      expect(taFragment.split(",").length).toBe(2);
      expect(diff.version.split("|").length).toBe(6);
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
    await setListingQuestions(listing.id, [q.id]);
    await saveChoice(source.id, a1.id);

    // Pass no questions — question text won't be found.
    const diff = await buildMergeDiff({ source, target });

    const answerItem = diff.answerItems.find((a) => a.questionId === q.id);
    expect(answerItem?.questionText).toBe(`Question #${q.id}`);
  });
});
