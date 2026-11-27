import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";

describeWithEnv(
  "Admin API - POST /api/admin/attendees answers to a listing-level question",
  { db: true, triggers: true },
  () => {
    test("refuses a booking-level answer to a question that asks once for each listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Disco Fair",
      });
      const { question: pupil } = await seedListingLevelQuestion([listing.id]);

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
