import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { validatePaidSession } from "#routes/api/payment-processing/classify.ts";
import {
  type CreatedEntry,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import { placeholderBookings } from "#routes/api/payment-processing/store-refund.ts";
import { parseTokens } from "#routes/tickets/token-utils.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  decryptSessionTokens,
  isSessionProcessed,
  releaseReservation,
} from "#shared/db/processed-payments.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  assertJson,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
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
      await setListingQuestions(listing.id, [question.id]);
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
      const failAfterCommit = stub(
        attendeesApi,
        "createBookingAtomic",
        async (...args) => {
          const result = await createBooking(...args);
          if (result === "sold-out" || !result.success) {
            throw new Error("Expected the synthetic booking to commit");
          }

          const attendees = result.attendees;
          let reads = 0;
          Object.defineProperty(result, "attendees", {
            get: () => {
              reads += 1;
              if (reads > 1) {
                throw new Error("synthetic post-commit failure");
              }
              return attendees;
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
            const ticketTokens = parseTokens(
              await decryptSessionTokens(processed!.ticket_tokens),
            );
            let recoveredEntries: CreatedEntry[] = [];
            await recoverOrRefundUnexpectedCreate({
              complete: (entries, recoveredTokens) => {
                recoveredEntries = entries;
                expect(recoveredTokens).toEqual(ticketTokens);
                return Promise.resolve(
                  sessionSuccess(attendeeId, listing.id, recoveredTokens),
                );
              },
              error: new Error("unused recovery error"),
              intent: validation.data.intent,
              placeholders: placeholderBookings(
                validated.items,
                validation.data.intent,
              ),
              session: validation.data.session,
              ticketToken: ticketTokens[0]!,
              validatedItems: validated.items,
            });
            expect(recoveredEntries[0]!.attendee).toEqual({
              ...attendees[0]!,
              ...contactFields(validation.data.intent),
              checked_in: false,
              lat: "",
              lng: "",
              payment_id: validation.data.session.paymentReference,
              pii_blob: "",
              price_paid: String(attendees[0]!.price_paid),
              refunded: false,
              split_logistics_agents: false,
              ticket_token: ticketTokens[0]!,
            });

            const redirect = await redirectRequest(sessionId);
            expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
            const page = await followRedirect(redirect, handleRequest);
            expect(await page.text()).toContain(
              "Click here to view your ticket",
            );
          },
        );
      } finally {
        retrieve.restore();
        failAfterCommit.restore();
      }
    });

    test("does not refund a partially committed cart", async () => {
      const first = await setupWithListing();
      const second = await setupWithListing();
      const sessionId = "cs_partial_commit_failure";
      const items = JSON.stringify([
        { e: first.id, p: 1000, q: 1 },
        { e: second.id, p: 1000, q: 1 },
      ]);
      const createBooking = attendeesApi.createBookingAtomic;
      const failAfterPartialCommit = stub(
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
            await expect(webhookRequest()).rejects.toThrow(
              "synthetic partial post-commit failure",
            );
            expect(refund.calls.length).toBe(0);
            expect(
              (await getAttendeesRaw(first.id)).map(({ quantity }) => quantity),
            ).toEqual([1]);
            expect(await getAttendeesRaw(second.id)).toEqual([]);
          },
        );
      } finally {
        failAfterPartialCommit.restore();
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
