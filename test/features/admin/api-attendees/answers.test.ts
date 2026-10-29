import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { getBookedAnswers } from "#db/questions/attendee-answers/at-booking.ts";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
  loadAttendeeQuestionData,
} from "#db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import {
  addAnswer,
  assignQuestion,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A listing that asks a choice question and a free-text question, both
 * answered in the body — the shared fixture behind the answers tests. */
const seedAnsweringListing = async (name: string) => {
  const listing = await createTestListing({ maxAttendees: 10, name });
  const { answer: veggie, question: meal } = await assignQuestion(
    listing.id,
    "Meal?",
    "Veggie",
  );
  const allergies = await createQuestion("Allergies?", {
    displayType: "free_text",
  });
  await listingQuestions.setIds(listing.id, [meal.id, allergies.id]);
  return { allergies, listing, meal, veggie };
};

describeWithEnv(
  "Admin API - POST /api/admin/attendees answers",
  { db: true, triggers: true },
  () => {
    test("a choice answer and a free-text answer land and show on the attendee page", async () => {
      const { allergies, listing, meal, veggie } =
        await seedAnsweringListing("Answer Fair");
      const created = await assertJson(
        createBooking(listing.id, {
          answers: [
            { answerId: veggie.id, questionId: meal.id },
            { freeText: "Peanuts", questionId: allergies.id },
          ],
        }),
        201,
      );
      const attendeeId = created.attendee.id as number;

      const privateKey = await getTestPrivateKey();
      const answers = await getAttendeeAnswersBatch([attendeeId], {
        privateKey,
        texts: true,
      });
      expect(answers.answerIds.get(attendeeId)).toEqual([veggie.id]);
      expect(answers.textAnswers.get(attendeeId)?.get(allergies.id)).toBe(
        "Peanuts",
      );
      expect(
        (await getAttendeeTextAnswers(attendeeId, privateKey)).get(
          allergies.id,
        ),
      ).toBe("Peanuts");

      // The admin attendee page's own loader shows both answers.
      const page = await loadAttendeeQuestionData(
        [listing.id],
        [attendeeId],
        privateKey,
      );
      expect(page?.attendeeAnswerMap.get(attendeeId)).toEqual([veggie.id]);
      expect(page?.textAnswerMap?.get(attendeeId)?.get(allergies.id)).toBe(
        "Peanuts",
      );
    });

    test("the answers_at_booking snapshot matches the written answers", async () => {
      const { allergies, listing, meal, veggie } =
        await seedAnsweringListing("Snapshot Fair");
      const created = await assertJson(
        createBooking(listing.id, {
          answers: [
            { answerId: veggie.id, questionId: meal.id },
            { freeText: "Peanuts", questionId: allergies.id },
          ],
        }),
        201,
      );
      const attendeeId = created.attendee.id as number;

      // One snapshot row per answered question, with the choice and the text
      // in their own columns.
      const rows = await queryAll<{
        answer_id: number | null;
        free_text: string | null;
        free_text_index: string | null;
        question_id: number;
      }>(
        "SELECT question_id, answer_id, free_text, free_text_index FROM answers_at_booking WHERE attendee_id = ?",
        [attendeeId],
      );
      expect(rows).toHaveLength(2);
      const choice = rows.find((row) => row.question_id === meal.id)!;
      expect(choice.answer_id).toBe(veggie.id);
      expect(choice.free_text).toBeNull();
      const text = rows.find((row) => row.question_id === allergies.id)!;
      expect(text.answer_id).toBeNull();
      expect(text.free_text).not.toBeNull();
      expect(text.free_text_index).not.toBeNull();

      // Decrypted, every answer the booking wrote reads back unchanged.
      const booked = await getBookedAnswers(attendeeId, getTestPrivateKey);
      expect(booked).toHaveLength(2);
      const mealRow = booked.find((row) => row.questionId === meal.id)!;
      expect(mealRow.answer).toBe("Veggie");
      expect(mealRow.answerAtBooking).toBe("Veggie");
      expect(mealRow.changed).toBe(false);
      const allergyRow = booked.find((row) => row.questionId === allergies.id)!;
      expect(allergyRow.answer).toBe("Peanuts");
      expect(allergyRow.answerAtBooking).toBe("Peanuts");
      expect(allergyRow.changed).toBe(false);
    });

    test("a repeated free text reuses its strings row: the used count rises, no duplicate row", async () => {
      const { allergies, listing } = await seedAnsweringListing("Dedup Fair");
      for (const name of ["Vegan One", "Vegan Two"]) {
        await assertJson(
          createBooking(listing.id, {
            answers: [{ freeText: "Vegan", questionId: allergies.id }],
            name,
          }),
          201,
        );
      }

      const rows = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.used_count).toBe(2);
    });

    test("an assign_all question is answerable without a per-listing link", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Assign All Fair",
      });
      const meal = await createQuestion("Meal?", { assignAll: true });
      const veggie = await addAnswer(meal.id, 0, "Veggie");

      const created = await assertJson(
        createBooking(listing.id, {
          answers: [{ answerId: veggie.id, questionId: meal.id }],
        }),
        201,
      );
      const attendeeId = created.attendee.id as number;
      const answers = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(answers.get(attendeeId)).toEqual([veggie.id]);
      // The snapshot records the assign-all question too.
      const booked = await getBookedAnswers(attendeeId, getTestPrivateKey);
      expect(booked).toHaveLength(1);
      expect(booked[0]!.answer).toBe("Veggie");
    });
  },
);
