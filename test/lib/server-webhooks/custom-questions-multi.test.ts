// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** Submit a multi-ticket form against a stubbed `createCheckoutSession` (so
 *  the test drives the real checkout without a flaky Stripe HTTP round trip),
 *  and assert it redirects to checkout — the shared prelude before both
 *  "answers survive the webhook" scenarios below simulate the payment
 *  provider's callback. */
const submitMultiTicketFormWithStubbedCheckout = async (
  slug: string,
  formData: Record<string, string>,
  stubSessionId: string,
): Promise<void> => {
  const { stubCheckout } = await import("#test-utils/checkout.ts");
  const { checkout } = stubCheckout(stubSessionId);
  const { expectCheckoutRedirect } = await import("#test-utils/assertions.ts");
  const { submitMultiTicketForm } = await import("#test-utils/csrf.ts");
  try {
    const checkoutResponse = await submitMultiTicketForm(slug, formData);
    expectCheckoutRedirect(checkoutResponse);
  } finally {
    checkout.restore();
  }
};

/** Fetch both listings' attendees, assert each has exactly one and that
 *  they're the same shared attendee (a multi-listing checkout links one
 *  attendee to every listing it books), and return that attendee's id. */
const expectSharedAttendee = async (
  listing1Id: number,
  listing2Id: number,
): Promise<number> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  const att1 = await getAttendeesRaw(listing1Id);
  const att2 = await getAttendeesRaw(listing2Id);
  expect(att1.length).toBe(1);
  expect(att2.length).toBe(1);
  expect(att1[0]!.id).toBe(att2[0]!.id);
  return att1[0]!.id;
};

describeWithEnv(
  "server webhooks > custom questions (multi-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook saves custom question answers", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Answer WH",
        unitPrice: 500,
      });

      // Create a question and answer via DB
      const { questionsTable, answersTable } = await import(
        "#shared/db/questions/tables.ts"
      );
      const { setListingQuestions } = await import(
        "#shared/db/questions/queries.ts"
      );
      const { getAttendeeAnswersBatch } = await import(
        "#shared/db/questions/attendee-answers/reads.ts"
      );
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Large",
      });
      await setListingQuestions(listing1.id, [q.id]);

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_answer",
          metadata: signedMeta(
            {
              answer_ids: JSON.stringify({
                [String(listing1.id)]: [a.id],
              }),
              email: "answer@example.com",
              items: JSON.stringify([{ e: listing1.id, p: 500, q: 1 }]),
              name: "Answer Buyer",
            },
            500,
          ),
          paymentIntent: "pi_answer",
          sessionId: "cs_answer",
        }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(200);

        // Verify answers were saved for the created attendee
        const { getAttendeesRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const attendees = await getAttendeesRaw(listing1.id);
        expect(attendees.length).toBe(1);
        const answerMap = await getAttendeeAnswersBatch([attendees[0]!.id], {
          texts: false,
        });
        const attendeeAnswers = answerMap.get(attendees[0]!.id) ?? [];
        expect(attendeeAnswers).toEqual([a.id]);
      } finally {
        mockVerify.restore();
      }
    });

    test("saves custom question answers for paid multi-ticket checkout", async () => {
      await setupStripe();

      // Listing with questions (paid) and listing without questions (free)
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Paid",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi No Q Free",
      });

      // Add a custom question only to listing1
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Dietary needs?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "None",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Vegetarian",
      });
      await setListingQuestions(listing1.id, [q.id]);

      // Submit multi-ticket form with a question answer selected.
      // One listing is paid, so this triggers the payment flow.
      // Stub checkout creation to avoid flaky stripe-mock HTTP calls under
      // high concurrency — this test verifies webhook processing, not checkout.
      const slug = `${listing1.slug}+${listing2.slug}`;
      await submitMultiTicketFormWithStubbedCheckout(
        slug,
        {
          email: "qbuyer@example.com",
          name: "Q Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q.id}`]: String(a1.id),
        },
        "cs_multi_q_stub",
      );

      // Now simulate the webhook callback from the payment provider.
      // The metadata includes answer_ids serialized during checkout.
      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_multi_q",
          metadata: signedMeta(
            {
              answer_ids: JSON.stringify({
                [String(listing1.id)]: [a1.id],
              }),
              email: "qbuyer@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 1000, q: 1 },
                { e: listing2.id, p: 0, q: 1 },
              ]),
              name: "Q Buyer",
            },
            1000,
          ),
          paymentIntent: "pi_multi_q",
          sessionId: "cs_multi_q",
        }),
      );

      // With multi-listing attendees, one attendee is linked to both listings.
      // Answers are stored on the shared attendee ID.
      const attendeeId = await expectSharedAttendee(listing1.id, listing2.id);
      const batch = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(batch.get(attendeeId)).toEqual([a1.id]);
    });

    test("saves free-text answers for a multi-listing checkout shared across listings", async () => {
      await setupStripe();

      // One attendee books two listings, each asking its own free-text question.
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Free Text Paid",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Free Text Free",
      });

      const q1 = await questionsTable.insert({
        displayType: "free_text",
        text: "Access needs?",
      });
      const q2 = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });
      await setListingQuestions(listing1.id, [q1.id]);
      await setListingQuestions(listing2.id, [q2.id]);

      // Drive the real checkout so ticket-submit parses the free-text answers and
      // packs them into the checkout intent (encrypting the strings on the way).
      const slug = `${listing1.slug}+${listing2.slug}`;
      await submitMultiTicketFormWithStubbedCheckout(
        slug,
        {
          email: "textbuyer@example.com",
          name: "Text Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q1.id}`]: "Wheelchair access",
          [`question_${q2.id}`]: "Vegan",
        },
        "cs_text_q_stub",
      );

      // The encrypted strings now exist; resolve their ids to reference them in
      // the webhook metadata exactly as the real checkout would have.
      const stringIds = await getOrCreateStringIds([
        "Wheelchair access",
        "Vegan",
      ]);

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_text_q",
          metadata: signedMeta(
            {
              email: "textbuyer@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 1000, q: 1 },
                { e: listing2.id, p: 0, q: 1 },
              ]),
              name: "Text Buyer",
              text_answer_ids: JSON.stringify({
                [String(listing1.id)]: [
                  { q: q1.id, s: stringIds.get("Wheelchair access") },
                ],
                [String(listing2.id)]: [
                  { q: q2.id, s: stringIds.get("Vegan") },
                ],
              }),
            },
            1000,
          ),
          paymentIntent: "pi_text_q",
          sessionId: "cs_text_q",
        }),
      );

      // The same attendee is linked to both listings, so both free-text
      // answers land on the one attendee.
      const attendeeId = await expectSharedAttendee(listing1.id, listing2.id);
      const textAnswers = await getAttendeeTextAnswers(
        attendeeId,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q1.id)).toBe("Wheelchair access");
      expect(textAnswers.get(q2.id)).toBe("Vegan");
    });
  },
);
