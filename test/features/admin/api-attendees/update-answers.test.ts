import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { assignQuestion } from "#test/shared/db/questions/helpers.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createBooking,
  updateBooking,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "Admin API - PUT /api/admin/attendees answers",
  { db: true, triggers: true },
  () => {
    test("stores the answers a body names and refuses a question the booking does not ask", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Answer Update Fair",
      });
      const { answer, question } = await assignQuestion(
        listing.id,
        "Meal?",
        "Veggie",
      );
      const created = await assertJson(createBooking(listing.id), 201);
      const attendeeId = created.attendee.id as number;

      await assertJson(
        updateBooking(attendeeId, {
          answers: [{ answerId: answer.id, questionId: question.id }],
        }),
        200,
      );
      const stored = await getAttendeeAnswersBatch([attendeeId], {
        privateKey: await getTestPrivateKey(),
        texts: true,
      });
      expect(stored.answerIds.get(attendeeId)).toEqual([answer.id]);

      await expectApiError(
        updateBooking(attendeeId, {
          answers: [{ answerId: answer.id, questionId: 987654 }],
        }),
        400,
        "answers[0] names a question this booking does not ask",
      );
    });
  },
);
