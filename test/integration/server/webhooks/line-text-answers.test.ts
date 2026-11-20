import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { expectSignedOrderProcessed } from "#test-utils/webhooks.ts";

describeWithEnv(
  "server webhooks > questions that ask once for each listing",
  { db: true },
  () => {
    test("a paid order files each listing's answer against that listing", async () => {
      await setupStripe();
      const [listing1, listing2] = await createListingPair({
        maxQuantity: 5,
        unitPrice: 500,
      });
      const { question } = await seedListingLevelQuestion([
        listing1.id,
        listing2.id,
      ]);
      const stringIds = await getOrCreateStringIds(["Ava", "Ben"]);

      await expectSignedOrderProcessed("line_text", 2000, {
        email: "pta@example.com",
        items: JSON.stringify([
          { e: listing1.id, p: 1000, q: 2 },
          { e: listing2.id, p: 1000, q: 2 },
        ]),
        line_text_answer_ids: JSON.stringify({
          [String(listing1.id)]: [{ q: question.id, s: stringIds.get("Ava") }],
          [String(listing2.id)]: [{ q: question.id, s: stringIds.get("Ben") }],
        }),
        name: "PTA Parent",
      });

      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      const [attendee] = await getAttendeesRaw(listing1.id);
      expect(
        await getAttendeeLineAnswers(attendee!.id, getTestPrivateKey),
      ).toEqual([
        { listingId: listing1.id, questionId: question.id, text: "Ava" },
        { listingId: listing2.id, questionId: question.id, text: "Ben" },
      ]);
    });
  },
);
