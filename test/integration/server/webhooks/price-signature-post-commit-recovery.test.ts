import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { hashEmail, hashPhone } from "#shared/db/contact-preferences.ts";
import { getRecentBookingTokens } from "#shared/db/contact-tokens.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  decryptSessionTokens,
  isSessionProcessed,
} from "#shared/db/processed-payments.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import {
  expectStoredRefund,
  redirectRequest,
  runWebhook,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "#test/lib/webhook-price-signature/helpers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { expectProcessedPaymentReference } from "#test-utils/processed-payments.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

const contactCountsByHash = async (hash: string) =>
  queryOne<{ public_booking_count: number; visits: number }>(
    `SELECT public_booking_count, visits FROM contact_preferences
     WHERE contact_hash = ?`,
    [hash],
  );

const contactCounts = async (email: string) =>
  contactCountsByHash(await hashEmail(email));

const phoneContactCounts = async (phone: string) =>
  contactCountsByHash(await hashPhone(phone));

const expectedBookingReferences = async (
  sessionId: string,
  listingId: number,
  modifierId: number,
): Promise<string[]> =>
  Promise.all([
    legReference(["booking", sessionId, "sale", listingId]),
    legReference(["booking", sessionId, "mod", modifierId]),
    legReference(["booking", sessionId, "payment"]),
  ]);

const expectContactActivity = async (
  email: string,
  phone: string,
  privateKey: CryptoKey,
  ticketToken: string,
): Promise<void> => {
  const expectedCounts = { public_booking_count: 1, visits: 1 };
  expect(await contactCounts(email)).toEqual(expectedCounts);
  expect(await phoneContactCounts(phone)).toEqual(expectedCounts);
  const expectedTokens = [{ source: "public" as const, token: ticketToken }];
  expect(
    await getRecentBookingTokens(await hashEmail(email), privateKey, 10),
  ).toEqual(expectedTokens);
  expect(
    await getRecentBookingTokens(await hashPhone(phone), privateKey, 10),
  ).toEqual(expectedTokens);
};

describeWithEnv("paid booking lost-result recovery", { db: true }, () => {
  test("recovers a committed result across webhook, redirect, and ledger replay", async () => {
    const listing = await setupWithListing();
    const sessionId = "cs_lost_committed_result";
    const email = "recovered@example.com";
    const phone = "+447700900123";
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
    const metadata = signMeta(
      webhookMeta({
        answer_ids: JSON.stringify({ [listing.id]: [answer.id] }),
        email,
        items: singleItem(listing.id, 1, 1000),
        modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
        name: "Recovered Buyer",
        phone,
      }),
      900,
    );
    const createBooking = attendeesApi.createBookingAtomic;
    const loseResult = stub(
      attendeesApi,
      "createBookingAtomic",
      async (...args) => {
        const result = await createBooking(...args);
        if (result === "sold-out" || !result.success) {
          throw new Error("Expected booking to commit");
        }
        throw new Error("synthetic lost create result");
      },
    );

    try {
      await runWebhook(
        { amount_total: 900, id: sessionId, metadata },
        async (refund) => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.processed).toBe(true);
          });
          expect(refund.calls.length).toBe(0);
          const [attendee] = await getAttendeesRaw(listing.id);
          expect(attendee?.quantity).toBe(1);
          expect(attendee?.price_paid).toBe(1000);
          const answers = await getAttendeeAnswersBatch([attendee!.id], {
            texts: false,
          });
          expect(answers.get(attendee!.id)).toEqual([answer.id]);
          const privateKey = await getTestPrivateKey();
          const [decrypted] = await decryptAttendees([attendee!], privateKey);
          const ticketToken = decrypted!.ticket_token;
          expect({
            id: decrypted!.id,
            paymentId: decrypted!.payment_id,
            ticketToken: decrypted!.ticket_token,
          }).toEqual({
            id: attendee!.id,
            paymentId: `pi_${sessionId}`,
            ticketToken,
          });
          const messages = (await getAllActivityLog()).map(
            ({ message }) => message,
          );
          expect(
            messages.filter(
              (message) =>
                message === `Attendee registered for '${listing.name}'`,
            ),
          ).toHaveLength(1);
          expect(
            messages.filter(
              (message) => message === "Promo code 'RECOVER' used: £1 off",
            ),
          ).toHaveLength(1);
          const processed = await isSessionProcessed(sessionId);
          expect(processed?.attendee_id).toBe(attendee!.id);
          expect(await decryptSessionTokens(processed!.ticket_tokens)).toBe(
            ticketToken,
          );
          await expectProcessedPaymentReference(
            attendee!.id,
            sessionId,
            `pi_${sessionId}`,
            privateKey,
          );
          const expectedReferences = await expectedBookingReferences(
            sessionId,
            listing.id,
            modifier.id,
          );
          const transfersAfterCommit = await allTransfers();
          expect(
            transfersAfterCommit.map(({ reference }) => reference),
          ).toEqual(expectedReferences);
          expect(
            transfersAfterCommit.map(({ eventGroup }) => eventGroup),
          ).toEqual(Array(3).fill(await bookingEventGroup(sessionId)));
          expect(await modifierUsedQuantities([modifier.id])).toEqual(
            new Map([[modifier.id, 1]]),
          );
          await expectContactActivity(email, phone, privateKey, ticketToken);

          const retrieve = stubRetrieveCheckoutSession({
            amountTotal: 900,
            metadata,
            paymentIntent: `pi_${sessionId}`,
            sessionId,
          });
          try {
            const redirect = await handleRequest(
              mockRequest(`/payment/success?session_id=${sessionId}`),
            );
            expect(redirect.status).toBe(302);
            expect(redirect.headers.get("location")).toContain(
              encodeURIComponent(ticketToken),
            );
            expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
            expect(await contactCounts(email)).toEqual({
              public_booking_count: 1,
              visits: 1,
            });
          } finally {
            retrieve.restore();
          }

          await execute(
            "DELETE FROM processed_payments WHERE payment_session_id = ?",
            [sessionId],
          );
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.processed).toBe(true);
          });
          const replayed = await isSessionProcessed(sessionId);
          expect(replayed?.attendee_id).toBe(attendee!.id);
          expect(await decryptSessionTokens(replayed!.ticket_tokens)).toBe("");
          expect(await getAttendeesRaw(listing.id)).toEqual([attendee]);
          await expectContactActivity(email, phone, privateKey, ticketToken);
          expect(await allTransfers()).toEqual(transfersAfterCommit);
          expect(await modifierUsedQuantities([modifier.id])).toEqual(
            new Map([[modifier.id, 1]]),
          );
          expect(
            (
              await getAttendeeAnswersBatch([attendee!.id], { texts: false })
            ).get(attendee!.id),
          ).toEqual([answer.id]);
          await expectProcessedPaymentReference(
            attendee!.id,
            sessionId,
            `pi_${sessionId}`,
            privateKey,
          );
          const finalMessages = (await getAllActivityLog()).map(
            ({ message }) => message,
          );
          expect(finalMessages).toEqual(messages);
          expect(refund.calls.length).toBe(0);
        },
      );
    } finally {
      loseResult.restore();
    }
  });

  test("refunds and removes the stage when the atomic create rolled back", async () => {
    const listing = await setupWithListing();
    const session = {
      id: "cs_proven_rollback",
      metadata: signedMeta(1000, {
        items: singleItem(listing.id, 1, 1000),
      }),
    };
    await execute(
      `CREATE TRIGGER test_late_payment_finalize_failure
       AFTER UPDATE OF attendee_id ON processed_payments
       WHEN NEW.payment_session_id = '${session.id}'
       BEGIN
         SELECT RAISE(ABORT, 'late payment finalize failure');
       END`,
    );
    try {
      await runWebhook(session, async (refund) => {
        await expectStoredRefund(listing.id);
        await expectStoredRefund(listing.id);
        expect(refund.calls.length).toBe(1);
        expect(await getAttendeesRaw(listing.id)).toEqual([]);
        expect(await loadCheckoutStageByPaymentSession(session.id)).toBeNull();
      });
    } finally {
      await execute("DROP TRIGGER test_late_payment_finalize_failure");
    }
  });

  test("a concurrent redirect and webhook converge on one stable ticket without refund", async () => {
    const listing = await setupWithListing();
    const sessionId = "cs_redirect_webhook_race";
    const metadata = signedMeta(1000, {
      items: singleItem(listing.id, 1, 1000),
    });

    await runWebhook({ id: sessionId, metadata }, async (refund) => {
      const activateStage = attendeesApi.activateStagedAttendee;
      const committedBooking = Promise.withResolvers<{
        attendeeId: number;
        ticketToken: string;
      }>();
      const releaseBooking = Promise.withResolvers<void>();
      const pauseBooking = stub(
        attendeesApi,
        "activateStagedAttendee",
        async (...args) => {
          const result = await activateStage(...args);
          if (!result.success) {
            throw new Error("Expected booking to commit");
          }
          const [stage] = args;
          committedBooking.resolve({
            attendeeId: stage.attendeeId,
            ticketToken: stage.ticketToken,
          });
          await releaseBooking.promise;
          return result;
        },
      );
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        metadata,
        paymentIntent: `pi_${sessionId}`,
        sessionId,
      });
      try {
        const firstWebhook = webhookRequest();
        const committed = await committedBooking.promise;
        const competingRedirect = await redirectRequest(sessionId);
        expect(competingRedirect.status).toBe(302);
        expect(competingRedirect.headers.get("location")).toBe(
          `/payment/success?tokens=${encodeURIComponent(
            committed.ticketToken,
          )}`,
        );
        releaseBooking.resolve();
        await assertJson(firstWebhook, 200, (json) => {
          expect(json.processed).toBe(true);
        });
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(true);
        });
        const redirect = await redirectRequest(sessionId);
        expect(redirect.status).toBe(200);
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees).toHaveLength(1);
        const attendee = attendees[0]!;
        const [decrypted] = await decryptAttendees(
          [attendee],
          await getTestPrivateKey(),
        );
        expect(decrypted!.id).toBe(committed.attendeeId);
        expect(decrypted!.ticket_token).toBe(committed.ticketToken);
        const processed = await isSessionProcessed(sessionId);
        expect(processed!.attendee_id).toBe(committed.attendeeId);
        expect(await decryptSessionTokens(processed!.ticket_tokens)).toBe("");
        const replayedRedirect = await redirectRequest(sessionId);
        expect(replayedRedirect.status).toBe(200);
        expect(await getAttendeesRaw(listing.id)).toEqual(attendees);
        expect(refund.calls.length).toBe(0);
      } finally {
        releaseBooking.resolve();
        pauseBooking.restore();
        retrieve.restore();
      }
    });
  });
});
