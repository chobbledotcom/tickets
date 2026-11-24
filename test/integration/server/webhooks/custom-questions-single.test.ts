import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import {
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
} from "#db/questions/attendee-answers/reads.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { sql } from "#db/sql.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  freeTextQuestionsOn,
  seedListingLevelQuestion,
  seedQuestion,
} from "#test-utils/db-helpers/question-seeds.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

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

    /** Send a paid order of one £10 ticket on the listing through the webhook.
     * The metadata carries the buyer and these answer fields. `key` names the
     * event, the payment and the session. */
    const processPaidOrder = (
      listingId: number,
      key: string,
      {
        email,
        name,
        ...answers
      }: Record<string, string> & {
        email: string;
        name: string;
      },
    ) =>
      expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: `evt_${key}`,
          metadata: signedMeta(
            { email, items: singleItem(listingId, 1, 1000), name, ...answers },
            1000,
          ),
          paymentIntent: `pi_${key}`,
          sessionId: `cs_${key}`,
        }),
      );

    test("saves custom question answers for paid single-ticket checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Single Q Paid",
        unitPrice: 1000,
      });

      const {
        answers: [a1],
      } = await seedQuestion({
        answers: ["Vegan"],
        listingIds: [listing.id],
        text: "Dietary needs?",
      });

      await processPaidOrder(listing.id, "single_q", {
        answer_ids: JSON.stringify({
          [String(listing.id)]: [a1.id],
        }),
        email: "qsingle@example.com",
        name: "Q Single Buyer",
      });

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
      const { question } = await seedQuestion({
        displayType: "free_text",
        listingIds: [listing.id],
        text: "Access needs?",
      });

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
            [`question${question.id}`]: "Step-free entrance",
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
      await processPaidOrder(listing.id, "round_trip", {
        email: "rt@example.com",
        name: "Round Tripper",
        text_answer_ids: JSON.stringify(getCaptured()!.listingTextAnswerIds),
      });

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
      const [goodQ, lostQ, nonsenseQ] = await freeTextQuestionsOn(listing.id, [
        "Access needs?",
        "Dietary needs?",
        "Anything else?",
      ]);

      const stringIds = await getOrCreateStringIds(["Step-free entrance"]);

      // lostQ's ref has no `s`; nonsenseQ's `s` is not a string id. The money
      // is already taken, so the booking must still finalize.
      await processPaidOrder(listing.id, "corrupt_ref", {
        email: "corrupt@example.com",
        name: "Corrupt Ref Buyer",
        text_answer_ids: JSON.stringify({
          [String(listing.id)]: [
            { q: goodQ.id, s: stringIds.get("Step-free entrance") },
            { q: lostQ.id },
            { q: nonsenseQ.id, s: "not-a-string-id" },
          ],
        }),
      });

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
      const savedForBadRefs = await getDb().execute(
        sql`SELECT question_id FROM attendee_answers WHERE attendee_id = ${attendeeId} AND question_id IN (${lostQ.id}, ${nonsenseQ.id})`,
      );
      expect(savedForBadRefs.rows).toEqual([]);

      // The dropped answer is surfaced loudly, not swallowed silently. This
      // reads the console line, which is written as the answer is dropped —
      // the copy in the activity log is written afterwards and is skipped
      // while another error is still being written, so it cannot be relied on.
      expect(errors.contains("Text answer ref has no usable string id")).toBe(
        true,
      );
    });

    test("finalizes a paid booking when a ticket answer ref has no usable string id, dropping that answer", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Lost Ticket Ref",
        unitPrice: 1000,
      });
      const { question } = await seedListingLevelQuestion(
        [listing.id],
        "Pupil name",
        "quantity",
      );

      await processPaidOrder(listing.id, "lost_ticket_ref", {
        email: "lost@example.com",
        line_text_answer_ids: JSON.stringify([
          { g: 0, l: listing.id, p: 0, q: question.id, u: 0 },
        ]),
        name: "Lost Ref Buyer",
      });

      const attendeeId = await soleAttendeeId(listing.id);
      const saved = await getDb().execute(
        sql`SELECT question_id FROM attendee_answers WHERE attendee_id = ${attendeeId}`,
      );
      expect(saved.rows).toEqual([]);
      expect(
        errors.contains(
          `Text answer ref has no usable string id (question ${question.id})`,
        ),
      ).toBe(true);
    });
  },
);
