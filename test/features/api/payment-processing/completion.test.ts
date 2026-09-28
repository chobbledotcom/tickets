import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { encrypt } from "#crypto/encryption.ts";
import {
  deleteCheckoutAnswers,
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, getDb } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  completePaidBooking,
  resumeFinalizedSession,
} from "#routes/api/payment-processing/completion.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import { loadSubmittedAnswerLines } from "#shared/email/answer-receipt.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { bookedLine, bookingIntent, trustedPayment } from "./index/helpers.ts";

/** Stage the snapshot the real checkout factory writes: one entry per booked
 * line, here with no answers of its own. */
const stageFor = async (
  sessionId: string,
  entries: readonly CreatedEntry[],
): Promise<void> =>
  stageCheckoutAnswers(
    sessionId,
    undefined,
    entries.map(({ listing }) => ({ answers: [], listingId: listing.id })),
  );

/** What the checkout signed, with no answers and nothing added on top. */
const bareIntent = (): BookingIntent =>
  bookingIntent([{ e: 1, p: 1000, q: 1 }]);

const noPackageFacts = (): RegistrationPackageFacts => ({
  displays: new Map(),
  pricingByGroup: new Map(),
});

/** Whether the log mentions the given words. The log is kept encrypted, so
 *  this reads it back the way the owner's log page does. */
const logMentions = async (words: string): Promise<boolean> =>
  (await getAllActivityLog()).some((entry) => entry.message.includes(words));

/** Write the processed_payments row a finalized session would have, with the
 * ticket tokens already sealed the way the finalize writes them ('' while none
 * were stored). */
const ledgerPayment = async (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string,
): Promise<void> => {
  await execute(
    `INSERT INTO processed_payments
       (payment_session_id, attendee_id, processed_at, ticket_tokens)
     VALUES (?, ?, ?, ?)`,
    [sessionId, attendeeId, new Date().toISOString(), ticketTokens],
  );
};

/** Drive the resume of a finalized session whose staged row exists but whose
 * ticket token cannot be recovered, and hand back the console errors printed. */
const resumeSession = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  overrides: Partial<Omit<BookingIntent, "items">> = {},
): Promise<string[]> => {
  using errors = spy(console, "error");
  await resumeFinalizedSession(
    sessionId,
    attendeeId,
    trustedPayment(
      sessionId,
      bookingIntent([{ e: listingId, p: 1000, q: 1 }], overrides),
      1000,
    ),
  );
  return errors.calls.map((call) => String(call.args[0]));
};

describeWithEnv(
  "finishing off a booking that has been paid",
  { db: true },
  () => {
    const fetch = stubFetchEachTest(() => new Response());

    test("hands back the first line's booking, listing, and tickets", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("First Line");

      await stageFor("cs_completion_first_line", [entry]);

      expect(
        await completePaidBooking(
          [entry],
          bareIntent(),
          [],
          [],
          ["tok_a", "tok_b"],
          noPackageFacts(),
          "cs_completion_first_line",
        ),
      ).toEqual({
        attendee: { id: attendeeId },
        listingId,
        success: true,
        ticketTokens: ["tok_a", "tok_b"],
      });
    });

    test("answers about the first line even when several were booked", async () => {
      // The buyer gets one thank-you page, and it is the first line's.
      const first = await bookedLine("Leading Line");
      const second = await bookedLine("Trailing Line");

      await stageFor("cs_completion_several_lines", [
        first.entry,
        second.entry,
      ]);
      const result = await completePaidBooking(
        [first.entry, second.entry],
        bareIntent(),
        [],
        [],
        [],
        noPackageFacts(),
        "cs_completion_several_lines",
      );

      expect(result).toMatchObject({
        attendee: { id: first.attendeeId },
        listingId: first.listingId,
      });
      expect(result).not.toMatchObject({ listingId: second.listingId });
    });

    test("saves the answers the buyer gave", async () => {
      const { attendeeId, entry, listingId } =
        await bookedLine("Answered Line");
      const question = await questionsTable.insert({
        displayType: "select",
        text: "Any allergies?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Peanuts",
      });
      await listingQuestions.setIds(listingId, [question.id]);
      await stageFor("cs_completion_saves_answers", [entry]);

      await completePaidBooking(
        [entry],
        {
          ...bareIntent(),
          listingAnswerIds: { [String(listingId)]: [answer.id] },
        },
        [],
        [],
        [],
        noPackageFacts(),
        "cs_completion_saves_answers",
      );

      const saved = await getDb().execute({
        args: [attendeeId],
        sql: "SELECT answer_id FROM attendee_answers WHERE attendee_id = ?",
      });
      expect(saved.rows.map((row) => row.answer_id)).toEqual([answer.id]);
    });

    // A code the buyer used is written down against the booking it changed, so
    // the owner can see why the price was what it was.
    test("writes down a code the buyer used", async () => {
      const { entry } = await bookedLine("Coded Line");
      const codeSpecs: ModifierSpec[] = [
        {
          id: 1,
          kind: "fixed",
          listingIds: null,
          name: "Ten off",
          quantity: 1,
          trigger: "code",
          value: -100,
        },
      ];

      const applications: ModifierApplication[] = [
        {
          amountApplied: -100,
          delta: -100,
          modifierId: 1,
          name: "Ten off",
          quantity: 1,
          scopedSubtotal: 1000,
        },
      ];
      await stageFor("cs_completion_promo_code", [entry]);
      const calls = await countDatabaseCalls(8, () =>
        completePaidBooking(
          [entry],
          bareIntent(),
          codeSpecs,
          applications,
          [],
          noPackageFacts(),
          "cs_completion_promo_code",
        ),
      );

      expect(calls).toBe(8);
      expect(await logMentions("Promo code 'Ten off' used")).toBe(true);
    });

    test("writes down no code when the buyer used none", async () => {
      const { entry } = await bookedLine("Codeless Line");
      await stageFor("cs_completion_no_code", [entry]);

      await completePaidBooking(
        [entry],
        bareIntent(),
        [],
        [],
        [],
        noPackageFacts(),
        "cs_completion_no_code",
      );

      expect(await logMentions("Promo code")).toBe(false);
    });

    test("reuses paid package facts for notification rendering", async () => {
      const { entry } = await bookedLine("Paid package member");
      await configureTestEmail();
      const packageGroupId = 91;
      const packagedEntry: CreatedEntry = {
        attendee: { ...entry.attendee, package_group_id: packageGroupId },
        listing: {
          ...entry.listing,
          webhook_url: "https://example.com/registration",
        },
      };
      const facts: RegistrationPackageFacts = {
        displays: new Map([
          [packageGroupId, { hideListings: true, name: "Paid package" }],
        ]),
        pricingByGroup: new Map([
          [
            packageGroupId,
            {
              dayPriceMap: new Map(),
              memberIds: new Set([entry.listing.id]),
              priceMap: new Map([[entry.listing.id, 1000]]),
              quantityMap: new Map([[entry.listing.id, 1]]),
            },
          ],
        ]),
      };
      await stageFor("cs_completion_package_facts", [packagedEntry]);
      const calls = await countDatabaseCalls(8, () =>
        runWithPendingWork(() =>
          completePaidBooking(
            [packagedEntry],
            bareIntent(),
            [],
            [],
            [],
            facts,
            "cs_completion_package_facts",
          ),
        ),
      );
      expect(calls).toBe(8);
    });

    test("closes the staging of a balance settlement without running the tail", async () => {
      const { entry } = await bookedLine("Balance settle line");
      const sessionId = "cs_completion_balance_resume";
      await stageFor(sessionId, [entry]);
      const messages = await resumeSession(sessionId, 4242, entry.listing.id, {
        balanceAttendeeId: 4242,
      });
      expect(messages).toEqual([]);
      // The balance arm closed the staged row itself: nothing owed a tail.
      expect(await readCheckoutAnswers(sessionId)).toBeNull();
    });

    test("leaves a finalized session whose ticket token cannot be recovered for the sweep", async () => {
      // Every shape of a lost token: cleared field, empty plaintext, pruned row.
      for (const [suffix, tokens] of [
        ["cleared", ""],
        ["empty_plaintext", await encrypt("")],
        ["pruned", null],
      ] as const) {
        const { attendeeId, listingId } = await bookedLine(`Lost ${suffix}`);
        const sessionId = `cs_completion_tokens_${suffix}`;
        await stageCheckoutAnswers(sessionId, undefined, [
          { answers: [], listingId },
        ]);
        if (tokens !== null) await ledgerPayment(sessionId, attendeeId, tokens);
        const messages = await resumeSession(sessionId, attendeeId, listingId);
        expect(messages.join("\n")).toContain("ticket token is gone");
        // The staged row survives for the terminal sweep and admin resend.
        expect(await readCheckoutAnswers(sessionId)).not.toBeNull();
      }
    });

    test("skips a finalized session whose tail already ran", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("Swept line");
      const sessionId = "cs_completion_already_swept";
      await stageFor(sessionId, [entry]);
      await deleteCheckoutAnswers(sessionId);
      expect(await resumeSession(sessionId, attendeeId, listingId)).toEqual([]);
    });

    test("resumes the answers, receipt, and email of an already-finalized session", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("Resumed line");
      const questionId = await createFreeTextQuestion([listingId]);
      const strings = await getOrCreateStringIds(["Arriving late"]);
      const stringId = strings.get("Arriving late")!;
      const sessionId = "cs_completion_resume_tail";
      await stageCheckoutAnswers(
        sessionId,
        { [String(questionId)]: "Arriving late" },
        [
          {
            answers: [
              {
                kind: "free_text",
                question: "Anything else?",
                questionId,
                text: "Arriving late",
              },
            ],
            listingId,
          },
        ],
      );
      const tokens = await encrypt("tok_resume_a+tok_resume_b");
      await ledgerPayment(sessionId, attendeeId, tokens);
      // The ticket-form fixture wrote an empty receipt header; a payment-flow
      // attendee has none, so clear it before the tail writes the real one.
      await execute(
        "DELETE FROM submitted_answer_receipts WHERE attendee_id = ?",
        [attendeeId],
      );
      await configureTestEmail();
      const data = trustedPayment(
        sessionId,
        bookingIntent([{ e: listingId, p: 1000, q: 1 }], {
          listingTextAnswerIds: {
            [String(listingId)]: [{ q: questionId, s: stringId }],
          },
        }),
        1000,
      );

      await runWithPendingWork(() =>
        resumeFinalizedSession(sessionId, attendeeId, data),
      );
      const saved = await getDb().execute({
        args: [attendeeId],
        sql: "SELECT question_id FROM attendee_answers WHERE attendee_id = ?",
      });
      expect(saved.rows.map((row) => row.question_id)).toEqual([questionId]);
      const lines = await loadSubmittedAnswerLines(
        [entry],
        new Map([[questionId, "Arriving late"]]),
      );
      expect(lines.get(attendeeId)?.get(listingId)).toEqual([
        { question: "Anything else?", text: "Arriving late" },
      ]);
      const bodies = fetch.calls.map((call) =>
        JSON.parse((call.args as [string, RequestInit])[1]!.body as string),
      );
      expect(
        bodies.find((body) => body.to?.[0] === "buyer@example.com")?.text,
      ).toContain("Arriving late");
      expect(await readCheckoutAnswers(sessionId)).toBeNull();
    });
  },
);
