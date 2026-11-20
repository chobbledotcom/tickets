import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeLineAnswers } from "#db/questions/attendee-answers/reads.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { seedQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

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
      const { question } = await seedQuestion({
        answerLevel: "listing",
        displayType: "free_text",
        listingIds: [listing1.id, listing2.id],
        text: "Pupil name",
      });
      const stringIds = await getOrCreateStringIds(["Ava", "Ben"]);

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 2000,
          eventId: "evt_line_text",
          metadata: signedMeta(
            {
              email: "pta@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 1000, q: 2 },
                { e: listing2.id, p: 1000, q: 2 },
              ]),
              line_text_answer_ids: JSON.stringify({
                [String(listing1.id)]: [
                  { q: question.id, s: stringIds.get("Ava") },
                ],
                [String(listing2.id)]: [
                  { q: question.id, s: stringIds.get("Ben") },
                ],
              }),
              name: "PTA Parent",
            },
            2000,
          ),
          paymentIntent: "pi_line_text",
          sessionId: "cs_line_text",
        }),
      );

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
