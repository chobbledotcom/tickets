// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > custom questions (single-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("saves custom question answers for paid single-ticket checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Single Q Paid",
        unitPrice: 1000,
      });

      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Dietary needs?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Vegan",
      });
      await setListingQuestions(listing.id, [q.id]);

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_single_q",
          metadata: signedMeta(
            {
              answer_ids: JSON.stringify({
                [String(listing.id)]: [a1.id],
              }),
              email: "qsingle@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Q Single Buyer",
            },
            1000,
          ),
          paymentIntent: "pi_single_q",
          sessionId: "cs_single_q",
        }),
      );

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);

      // Verify custom question answers were saved
      const batch = await getAttendeeAnswersBatch([attendees[0]!.id], {
        texts: false,
      });
      expect(batch.get(attendees[0]!.id)).toEqual([a1.id]);
    });

    test("a submitted free-text answer keeps its string id through checkout and the webhook", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Round Trip Paid",
        unitPrice: 1000,
      });
      const question = await questionsTable.insert({
        displayType: "free_text",
        text: "Access needs?",
      });
      await setListingQuestions(listing.id, [question.id]);

      // Drive the REAL checkout so ticket-submit resolves the free-text answer
      // to a string id and packs it into the intent. Capture that intent: its
      // listingTextAnswerIds is exactly what gets serialized into the provider
      // metadata, so a dropped `s` here is the production bug. The earlier
      // free-text test hand-built this metadata and so could never catch it.
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const captured: CheckoutIntent[] = [];
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: CheckoutIntent) => {
          captured.push(intent);
          return Promise.resolve({
            checkoutUrl: "https://checkout.stripe.com/pay/cs_round_trip",
            sessionId: "cs_round_trip",
          });
        },
      );
      const { expectCheckoutRedirect } = await import(
        "#test-utils/assertions.ts"
      );
      const { submitTicketForm } = await import("#test-utils/csrf.ts");
      try {
        expectCheckoutRedirect(
          await submitTicketForm(listing.slug, {
            email: "rt@example.com",
            name: "Round Tripper",
            [`question_${question.id}`]: "Step-free entrance",
          }),
        );
      } finally {
        mockCreate.restore();
      }

      // The resolved ref must carry a real numeric string id, never the
      // undefined that JSON.stringify would silently drop from signed metadata.
      const refs = captured[0]!.listingTextAnswerIds![String(listing.id)]!;
      expect(refs.length).toBe(1);
      expect(refs[0]!.q).toBe(question.id);
      expect(Number.isInteger(refs[0]!.s)).toBe(true);

      // Serialize those exact refs into webhook metadata the way production does
      // and confirm the submitted text survives the full round-trip.
      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_round_trip",
          metadata: signedMeta(
            {
              email: "rt@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Round Tripper",
              text_answer_ids: JSON.stringify(
                captured[0]!.listingTextAnswerIds,
              ),
            },
            1000,
          ),
          paymentIntent: "pi_round_trip",
          sessionId: "cs_round_trip",
        }),
      );

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      const textAnswers = await getAttendeeTextAnswers(
        attendees[0]!.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(question.id)).toBe("Step-free entrance");
    });

    test("finalizes a paid booking when a text-answer ref lost its string id, dropping only that answer", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Corrupt Ref Paid",
        unitPrice: 1000,
      });
      const goodQ = await questionsTable.insert({
        displayType: "free_text",
        text: "Access needs?",
      });
      const lostQ = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });
      await setListingQuestions(listing.id, [goodQ.id, lostQ.id]);

      const stringIds = await getOrCreateStringIds(["Step-free entrance"]);

      // lostQ's ref carries no `s` — the corrupt shape a pre-fix checkout wrote
      // when the string-id read raced replication and JSON.stringify dropped it.
      // The payment is already captured, so the booking must finalize (200,
      // processed) rather than crash-loop on the unsupported undefined bind.
      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_corrupt_ref",
          metadata: signedMeta(
            {
              email: "corrupt@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Corrupt Ref Buyer",
              text_answer_ids: JSON.stringify({
                [String(listing.id)]: [
                  { q: goodQ.id, s: stringIds.get("Step-free entrance") },
                  { q: lostQ.id },
                ],
              }),
            },
            1000,
          ),
          paymentIntent: "pi_corrupt_ref",
          sessionId: "cs_corrupt_ref",
        }),
      );

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);

      // The intact answer is saved; the ref with no id is dropped, not guessed.
      const textAnswers = await getAttendeeTextAnswers(
        attendees[0]!.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(goodQ.id)).toBe("Step-free entrance");
      expect(textAnswers.has(lostQ.id)).toBe(false);

      // The dropped answer is surfaced loudly, not swallowed silently.
      const log = await getAllActivityLog();
      expect(
        log.some((entry) =>
          entry.message.includes("Text answer ref missing string id"),
        ),
      ).toBe(true);
    });
  },
);
