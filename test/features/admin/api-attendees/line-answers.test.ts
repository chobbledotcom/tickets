import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingQuestions } from "#db/questions/queries.ts";
import { createQuestion } from "#test/shared/db/questions/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "Admin API - POST /api/admin/attendees answers to a listing-level question",
  { db: true, triggers: true },
  () => {
    test("refuses a booking-level answer to a question that asks once for each listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Disco Fair",
      });
      const pupil = await createQuestion("Pupil name", {
        answerLevel: "listing",
        displayType: "free_text",
      });
      await listingQuestions.setIds(listing.id, [pupil.id]);

      await assertJson(
        createBooking(listing.id, {
          answers: [{ freeText: "Ava", questionId: pupil.id }],
        }),
        400,
        (body: { error: string }) => {
          expect(body.error).toBe(
            "answers[0] names a question this booking does not ask",
          );
        },
      );
    });
  },
);
