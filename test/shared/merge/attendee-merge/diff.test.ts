import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
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

    test("includes version hash in diff", async () => {
      const { source, target } = await createMergePair({ sameListing: true });

      const diff = await buildMergeDiff({ source, target });

      expect(diff.version).toBeTruthy();
      expect(typeof diff.version).toBe("string");
    });
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
