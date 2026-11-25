/** A merge keeps each answer on the dated booking row that it belongs to. Two
 * bookings of one daily listing on two dates are two rows, so their answers
 * stay apart. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { countStoredAnswersByDate } from "#test-utils/db-helpers/line-answers.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { mergedLineTexts, saveLineAnswer } from "./helpers.ts";

describeWithEnv("a merge of answers on dated bookings", { db: true }, () => {
  test("keeps each answer on its own date", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 10 });
    const target = await bookTestAttendee(
      [{ date: "2026-06-01", listingId: listing.id }],
      "Alice",
    );
    const source = await bookTestAttendee(
      [{ date: "2026-06-08", listingId: listing.id }],
      "Bob",
    );
    const { question } = await seedListingLevelQuestion();
    await saveLineAnswer(target.id, listing.id, question.id, "Ava");
    await saveLineAnswer(source.id, listing.id, question.id, "Ben");

    expect(await mergedLineTexts(source, target)).toEqual(["Ava", "Ben"]);
    expect(await countStoredAnswersByDate(target.id)).toEqual([1, 1]);
  });
});
