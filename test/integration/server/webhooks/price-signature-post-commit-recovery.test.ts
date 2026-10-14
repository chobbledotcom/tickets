import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bookingEventGroup } from "#accounting/mappers.ts";
import { allTransfers } from "#accounting/queries.ts";
import { legReference } from "#accounting/refs.ts";
import { encrypt } from "#crypto/encryption.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import {
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { hashEmail, hashPhone } from "#db/contact-preferences.ts";
import { getRecentBookingTokens } from "#db/contact-tokens.ts";
import { modifierUsedQuantities } from "#db/modifier-usage.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { decryptSessionTokens } from "#db/processed-payments.ts";
import { getBookedAnswers } from "#db/questions/attendee-answers/at-booking.ts";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { provisionTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expectProcessedPaymentReference,
  getProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

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
  const fetchSpy = stubFetchEachTest(() => new Response());
  // The spy records the file's whole run; each test counts only the calls
  // its own requests made.
  const callsSince = (baseline: number, url: string): number =>
    fetchSpy.calls
      .slice(baseline)
      .filter((one) => String(one.args[0]).includes(url)).length;
  const resendBodies = (
    baseline: number,
  ): { html: string; to: [string, ...string[]] }[] =>
    fetchSpy.calls
      .slice(baseline)
      .filter((one) => String(one.args[0]).includes("api.resend.com"))
      .map((one) => JSON.parse(one.args[1].body as string));

  test("recovers a committed result across webhook, redirect, and ledger replay", async () => {
    const fetchCallsBefore = fetchSpy.calls.length;
    const registrationCalls = (): number =>
      callsSince(fetchCallsBefore, "https://registration.example.com/hook");
    // The booked listing is a renewal tier, so the recovered sends also
    // extend the renewal site's deadline exactly once.
    const listing = await setupWithListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
    });
    await insertBuiltSite(
      "Recovery Renewal Site",
      "recovery-renewal.b-cdn.net",
      "",
      "",
      false,
      "5001",
    );
    const sites = await builtSites.getAll();
    const site = sites.find((one) => one.name === "Recovery Renewal Site")!;
    const { tokenIndex } = await provisionTestBuiltSite(site.id);
    const edgeSecretCalls = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.resolve({ ok: true as const }),
    );
    // The listings.fields column stores env-key encrypted values, so the
    // fixture writes the collected field the way every write path does.
    await execute(
      "UPDATE listings SET fields = ?, webhook_url = ? WHERE id = ?",
      [
        await encrypt("email"),
        await encrypt("https://registration.example.com/hook"),
        listing.id,
      ],
    );
    await configureTestEmail({ businessEmail: "owner@example.com" });
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
    const textQuestion = await questionsTable.insert({
      displayType: "free_text",
      text: "Anything else?",
    });
    await listingQuestions.setIds(listing.id, [question.id, textQuestion.id]);
    // Stage the buyer's typed answer the way the checkout session does, so
    // the completion reads it before the batch opens, and intern the text
    // the way the submit path does, so the answer ref points at the
    // owner-sealed copy the persistent answer keeps.
    const textStringId = (
      await getOrCreateStringIds(["Vegetarian, please"])
    ).get("Vegetarian, please")!;
    await stageCheckoutAnswers(
      sessionId,
      { [String(textQuestion.id)]: "Vegetarian, please" },
      null,
    );
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
        site_token_index: tokenIndex,
        text_answer_ids: JSON.stringify({
          [listing.id]: [{ q: textQuestion.id, s: textStringId }],
        }),
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
          // The owner-key reader resolves both the chosen answer and the
          // typed answer's owner-sealed copy, in question order.
          const booked = await getBookedAnswers(
            attendee!.id,
            getTestPrivateKey,
          );
          expect(booked).toEqual([
            {
              answer: "Recovered",
              answerAtBooking: "Recovered",
              askedAs: "Recovery answer?",
              changed: false,
              changesPrice: false,
              question: "Recovery answer?",
              questionId: question.id,
            },
            {
              answer: "Vegetarian, please",
              answerAtBooking: "Vegetarian, please",
              askedAs: "Anything else?",
              changed: false,
              changesPrice: false,
              question: "Anything else?",
              questionId: textQuestion.id,
            },
          ]);
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
          const processed = await getProcessedPayment(sessionId);
          expect(processed?.attendee_id).toBe(attendee!.id);
          expect(await decryptSessionTokens(processed!.ticket_tokens)).toBe(
            ticketToken,
          );
          await expectProcessedPaymentReference(
            attendee!.id,
            sessionId,
            taggedPaymentReference(`pi_${sessionId}`),
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

          // The lost result committed the booking without queueing its
          // sends; this recovery queued exactly one buyer confirmation and
          // one owner copy (two Resend calls) and one registration webhook.
          expect(registrationCalls()).toBe(1);
          const emailBodies = resendBodies(fetchCallsBefore);
          expect(
            emailBodies.filter((body) => body.to[0] === email).length,
          ).toBe(1);
          expect(
            emailBodies.filter((body) => body.to[0] === "owner@example.com")
              .length,
          ).toBe(1);
          // Both bodies carry the buyer's typed answer from the staged row.
          const buyerBody = emailBodies.find((body) => body.to[0] === email)!;
          expect(buyerBody.html).toContain("Anything else?");
          expect(buyerBody.html).toContain("Vegetarian, please");
          const ownerBody = emailBodies.find(
            (body) => body.to[0] === "owner@example.com",
          )!;
          expect(ownerBody.html).toContain("Anything else?");
          expect(ownerBody.html).toContain("Vegetarian, please");
          // The committed batch took the staged copy back with the booking.
          expect((await readCheckoutAnswers(sessionId)).size).toBe(0);
          // The recovered sends extended the renewal site's deadline once.
          const sitesAfterRecovery = await builtSites.getAll();
          expect(
            sitesAfterRecovery.find((one) => one.id === site.id)!.readOnlyFrom,
          ).toBe("2099-02-01T00:00:00.000Z");
          expect(edgeSecretCalls.calls.length).toBe(1);
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
          const replayed = await getProcessedPayment(sessionId);
          expect(replayed?.attendee_id).toBe(attendee!.id);
          expect(await decryptSessionTokens(replayed!.ticket_tokens)).toBe("");
          expect(await getAttendeesRaw(listing.id)).toEqual([attendee]);
          await expectContactActivity(email, phone, privateKey, ticketToken);
          // The finalized-session replay answers send-free: the recovery
          // already queued the one send the booking owed.
          expect(registrationCalls()).toBe(1);
          const replayEmailBodies = resendBodies(fetchCallsBefore);
          expect(
            replayEmailBodies.filter((body) => body.to[0] === email).length,
          ).toBe(1);
          expect(
            replayEmailBodies.filter(
              (body) => body.to[0] === "owner@example.com",
            ).length,
          ).toBe(1);
          // The redeliveries never re-extend the deadline: the finalized
          // session's replay queues no sends at all.
          expect(
            (await builtSites.getAll()).find((one) => one.id === site.id)!
              .readOnlyFrom,
          ).toBe("2099-02-01T00:00:00.000Z");
          expect(edgeSecretCalls.calls.length).toBe(1);
          expect(await allTransfers()).toEqual(transfersAfterCommit);
          expect(await modifierUsedQuantities([modifier.id])).toEqual(
            new Map([[modifier.id, 1]]),
          );
          expect(
            (
              await getAttendeeAnswersBatch([attendee!.id], { texts: false })
            ).get(attendee!.id),
          ).toEqual([answer.id]);
          // The replays re-read the same persisted answers: the typed copy
          // still resolves through the owner key, unchanged.
          expect(
            await getBookedAnswers(attendee!.id, getTestPrivateKey),
          ).toEqual(booked);
          await expectProcessedPaymentReference(
            attendee!.id,
            sessionId,
            taggedPaymentReference(`pi_${sessionId}`),
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
      edgeSecretCalls.restore();
      loseResult.restore();
    }
  });
});
