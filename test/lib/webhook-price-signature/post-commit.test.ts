import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { validatePaidSession } from "#routes/api/payment-processing/classify.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { parseTokens } from "#routes/tickets/token-utils.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { getContactRecord, hashEmail } from "#shared/db/contact-preferences.ts";
import { getRecentBookingTokens } from "#shared/db/contact-tokens.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  isSessionProcessed,
  releaseReservation,
} from "#shared/db/processed-payments.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  assertJson,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "./helpers.ts";

const STORED_BOOKING_FAILURE = {
  error:
    "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.",
  processed: false,
  received: true,
};

const expectStoredBookingFailure = () =>
  assertJson(webhookRequest(), 200, (json) => {
    expect(json).toEqual(STORED_BOOKING_FAILURE);
  });

const expectPlaceholders = async (listingIds: number[]): Promise<void> => {
  for (const listingId of listingIds) {
    expect(
      (await getAttendeesRaw(listingId)).map(({ quantity }) => quantity),
    ).toEqual([0]);
  }
};

describeWithEnv(
  "webhook signed price oracle - post-commit failures",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("recovers the ticket when post-commit processing throws", async () => {
      const listing = await setupWithListing();
      const sessionId = "cs_post_commit_failure";
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Recovery answer?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 1,
        text: "Recovered",
      });
      await listingQuestions.setIds(listing.id, [question.id]);
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 1,
        direction: "discount",
        name: "RECOVER",
        trigger: "code",
      });
      const metadata = signedMeta(900, {
        answer_ids: JSON.stringify({
          [String(listing.id)]: [answer.id],
        }),
        items: singleItem(listing.id, 1, 1000),
        modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
      });
      const createBooking = attendeesApi.createBookingAtomic;
      let racingRedirect: Response | null = null;
      const failAfterCommit = stub(
        attendeesApi,
        "createBookingAtomic",
        async (...args) => {
          const result = await createBooking(...args);
          if (result === "sold-out" || !result.success) {
            throw new Error("Expected the synthetic booking to commit");
          }

          racingRedirect = await redirectRequest(sessionId);

          Object.defineProperty(result, "attendees", {
            get: () => {
              throw new Error("synthetic post-commit failure");
            },
          });
          return result;
        },
      );
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 900,
        metadata,
        paymentIntent: `pi_${sessionId}`,
        sessionId,
      });

      try {
        await runWebhook(
          { amount_total: 900, id: sessionId, metadata },
          async (refund) => {
            await assertJson(webhookRequest(), 200, (json) => {
              expect(json.processed).toBe(true);
            });
            expect(refund.calls.length).toBe(0);
            const attendees = await getAttendeesRaw(listing.id);
            expect(attendees.map(({ quantity }) => quantity)).toEqual([1]);
            const attendeeId = attendees[0]!.id;
            const answers = await getAttendeeAnswersBatch([attendeeId], {
              texts: false,
            });
            expect(answers.get(attendeeId)).toEqual([answer.id]);
            const activity = await getAllActivityLog();
            expect(activity.map(({ message }) => message)).toEqual(
              expect.arrayContaining([
                `Attendee registered for '${listing.name}'`,
                "Promo code 'RECOVER' used: £1 off",
              ]),
            );

            const validation = await validatePaidSession(sessionId);
            if (!validation.ok)
              throw new Error("Expected a valid paid session");
            const validated = await validateAllItems(
              validation.data.session,
              validation.data.intent,
            );
            if ("success" in validated) {
              throw new Error("Expected valid recovery items");
            }
            const processed = await isSessionProcessed(sessionId);
            expect(processed?.ticket_tokens).toBe("");
            expect(racingRedirect).not.toBeNull();
            const redirect = racingRedirect!;
            expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
            const location = redirect.headers.get("location");
            expect(location).not.toBeNull();
            const ticketTokens = parseTokens(
              new URL(location!, "http://localhost").searchParams.get(
                "tokens",
              )!,
            );
            const contactHash = await hashEmail("buyer@example.com");
            const privateKey = await getTestPrivateKey();
            const contactRecord = await getContactRecord(
              contactHash,
              privateKey,
            );
            expect({
              publicBookingCount: contactRecord.publicBookingCount,
              visits: contactRecord.visits,
            }).toEqual({ publicBookingCount: 1, visits: 1 });
            expect(
              await getRecentBookingTokens(contactHash, privateKey, 1),
            ).toEqual([{ source: "public", token: ticketTokens[0] }]);
            const page = await followRedirect(redirect, handleRequest);
            expect(await page.text()).toContain("View your ticket");
          },
        );
      } finally {
        retrieve.restore();
        failAfterCommit.restore();
      }
    });

    test("refunds only after an incomplete cart leaves no live booking", async () => {
      const first = await setupWithListing();
      const second = await setupWithListing();
      const sessionId = "cs_partial_commit_failure";
      const items = JSON.stringify([
        { e: first.id, p: 1000, q: 1 },
        { e: second.id, p: 1000, q: 1 },
      ]);
      const createBooking = attendeesApi.createBookingAtomic;
      const failAfterIncompleteCreate = stub(
        attendeesApi,
        "createBookingAtomic",
        async (...args) => {
          await listingsTable.update(second.id, { active: false });
          await createBooking(...args);
          throw new Error("synthetic partial post-commit failure");
        },
      );

      try {
        await runWebhook(
          {
            amount_total: 2000,
            id: sessionId,
            metadata: signedMeta(2000, { items }),
          },
          async (refund) => {
            await expectStoredBookingFailure();
            expect(refund.calls.length).toBe(1);
            await expectPlaceholders([first.id, second.id]);

            const processed = await isSessionProcessed(sessionId);
            expect(processed).not.toBeNull();
            expect(processed!.failure_data).not.toBe("");
            await getDb().execute({
              args: ["2000-01-01T00:00:00.000Z", sessionId],
              sql: "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
            });

            await expectStoredBookingFailure();
            await expectPlaceholders([first.id, second.id]);
            expect(refund.calls.length).toBe(1);
          },
        );
      } finally {
        failAfterIncompleteCreate.restore();
      }
    });

    test("does not refund when an unexpected failure loses its reservation", async () => {
      const listing = await setupWithListing();
      const sessionId = "cs_missing_reservation_failure";
      const failWithoutReservation = stub(
        attendeesApi,
        "createBookingAtomic",
        async () => {
          await releaseReservation(sessionId);
          throw new Error("synthetic ambiguous failure");
        },
      );

      try {
        await runWebhook(
          {
            id: sessionId,
            metadata: signedMeta(1000, {
              items: singleItem(listing.id, 1, 1000),
            }),
          },
          async (refund) => {
            await expect(webhookRequest()).rejects.toThrow(
              "synthetic ambiguous failure",
            );
            expect(refund.calls.length).toBe(0);
            expect(await getAttendeesRaw(listing.id)).toEqual([]);
          },
        );
      } finally {
        failWithoutReservation.restore();
      }
    });
  },
);
