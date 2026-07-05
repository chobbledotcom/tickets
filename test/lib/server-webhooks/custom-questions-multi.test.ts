import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  answersTable,
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
  getOrCreateStringIds,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  postWebhookAndAssert,
  setupStripe,
  signedMeta,
  stubWebhookVerify,
} from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

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
      const {
        questionsTable,
        answersTable,
        setListingQuestions,
        getAttendeeAnswersBatch,
      } = await import("#shared/db/questions.ts");
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
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
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
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            checkoutUrl: "https://checkout.stripe.com/pay/cs_multi_q_stub",
            sessionId: "cs_multi_q_stub",
          }),
      );

      const { submitMultiTicketForm, expectCheckoutRedirect } = await import(
        "#test-utils"
      );
      const slug = `${listing1.slug}+${listing2.slug}`;
      try {
        const checkoutResponse = await submitMultiTicketForm(slug, {
          email: "qbuyer@example.com",
          name: "Q Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q.id}`]: String(a1.id),
        });
        expectCheckoutRedirect(checkoutResponse);
      } finally {
        mockCreate.restore();
      }

      // Now simulate the webhook callback from the payment provider.
      // The metadata includes answer_ids serialized during checkout.
      const mockVerify = await stubWebhookVerify(
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

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBe(true);
        },
      );

      // Verify attendees were created
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const att1 = await getAttendeesRaw(listing1.id);
      const att2 = await getAttendeesRaw(listing2.id);
      expect(att1.length).toBe(1);
      expect(att2.length).toBe(1);

      // With multi-listing attendees, one attendee is linked to both listings.
      // Answers are stored on the shared attendee ID.
      const attendeeId = att1[0]!.id;
      expect(attendeeId).toBe(att2[0]!.id); // same attendee
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
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () =>
          Promise.resolve({
            checkoutUrl: "https://checkout.stripe.com/pay/cs_text_q_stub",
            sessionId: "cs_text_q_stub",
          }),
      );
      const { submitMultiTicketForm, expectCheckoutRedirect } = await import(
        "#test-utils"
      );
      const slug = `${listing1.slug}+${listing2.slug}`;
      try {
        const checkoutResponse = await submitMultiTicketForm(slug, {
          email: "textbuyer@example.com",
          name: "Text Buyer",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q1.id}`]: "Wheelchair access",
          [`question_${q2.id}`]: "Vegan",
        });
        expectCheckoutRedirect(checkoutResponse);
      } finally {
        mockCreate.restore();
      }

      // The encrypted strings now exist; resolve their ids to reference them in
      // the webhook metadata exactly as the real checkout would have.
      const stringIds = await getOrCreateStringIds([
        "Wheelchair access",
        "Vegan",
      ]);

      const mockVerify = await stubWebhookVerify(
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

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBe(true);
        },
      );

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const att1 = await getAttendeesRaw(listing1.id);
      const att2 = await getAttendeesRaw(listing2.id);
      expect(att1.length).toBe(1);
      expect(att2.length).toBe(1);

      // The same attendee is linked to both listings, so both free-text
      // answers land on the one attendee.
      const attendeeId = att1[0]!.id;
      expect(attendeeId).toBe(att2[0]!.id);
      const textAnswers = await getAttendeeTextAnswers(
        attendeeId,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q1.id)).toBe("Wheelchair access");
      expect(textAnswers.get(q2.id)).toBe("Vegan");
    });
  },
);
