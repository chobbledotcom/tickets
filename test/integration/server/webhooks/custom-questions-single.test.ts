// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
} from "#db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
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
    const errors = setupErrorSpy();

    // Fetches a listing's attendees and returns the sole one's id, confirming
    // exactly one booking was made before a test reads its saved answers.
    const soleAttendeeId = async (listingId: number): Promise<number> => {
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      const attendees = await getAttendeesRaw(listingId);
      expect(attendees.length).toBe(1);
      return attendees[0]!.id;
    };

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
      await listingQuestions.setIds(listing.id, [q.id]);

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

      const attendeeId = await soleAttendeeId(listing.id);

      // Verify custom question answers were saved
      const batch = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(batch.get(attendeeId)).toEqual([a1.id]);
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
      await listingQuestions.setIds(listing.id, [question.id]);

      // Drive the REAL checkout so ticket-submit resolves the free-text answer
      // to a string id and packs it into the intent. Capture that intent: its
      // listingTextAnswerIds is exactly what gets serialized into the provider
      // metadata, so a dropped `s` here is the production bug. The earlier
      // free-text test hand-built this metadata and so could never catch it.
      const { stubCheckout } = await import("#test-utils/checkout.ts");
      const { checkout, getCaptured } = stubCheckout("cs_round_trip");
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
        checkout.restore();
      }

      // The resolved ref must carry a real numeric string id, never the
      // undefined that JSON.stringify would silently drop from signed metadata.
      const refs = getCaptured()!.listingTextAnswerIds![String(listing.id)]!;
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
                getCaptured()!.listingTextAnswerIds,
              ),
            },
            1000,
          ),
          paymentIntent: "pi_round_trip",
          sessionId: "cs_round_trip",
        }),
      );

      const textAnswers = await getAttendeeTextAnswers(
        await soleAttendeeId(listing.id),
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(question.id)).toBe("Step-free entrance");
    });

    test("finalizes a paid booking when a text-answer ref has no usable string id, dropping only those answers", async () => {
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
      const nonsenseQ = await questionsTable.insert({
        displayType: "free_text",
        text: "Anything else?",
      });
      await listingQuestions.setIds(listing.id, [
        goodQ.id,
        lostQ.id,
        nonsenseQ.id,
      ]);

      const stringIds = await getOrCreateStringIds(["Step-free entrance"]);

      // lostQ's ref has no `s`; nonsenseQ's `s` is not a string id. The money
      // is already taken, so the booking must still finalize.
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
                  { q: nonsenseQ.id, s: "not-a-string-id" },
                ],
              }),
            },
            1000,
          ),
          paymentIntent: "pi_corrupt_ref",
          sessionId: "cs_corrupt_ref",
        }),
      );

      // The intact answer is saved; the ref with no id is dropped, not guessed.
      const attendeeId = await soleAttendeeId(listing.id);
      const textAnswers = await getAttendeeTextAnswers(
        attendeeId,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(goodQ.id)).toBe("Step-free entrance");
      expect(textAnswers.has(lostQ.id)).toBe(false);

      // Read the saved rows rather than the answers, because an answer saved
      // against an id that points at no stored text reads back as absent — the
      // same as never having been saved. Only the row itself tells them apart.
      // Scoped to this booking: other bookings answer these questions too.
      const savedForBadRefs = await getDb().execute({
        args: [attendeeId, lostQ.id, nonsenseQ.id],
        sql: "SELECT question_id FROM attendee_answers WHERE attendee_id = ? AND question_id IN (?, ?)",
      });
      expect(savedForBadRefs.rows).toEqual([]);

      // The dropped answer is surfaced loudly, not swallowed silently. This
      // reads the console line, which is written as the answer is dropped —
      // the copy in the activity log is written afterwards and is skipped
      // while another error is still being written, so it cannot be relied on.
      expect(errors.contains("Text answer ref has no usable string id")).toBe(
        true,
      );
    });
  },
);
