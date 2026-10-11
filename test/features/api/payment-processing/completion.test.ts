import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute, getDb } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  prepareRegistrationWork,
  registrationWorkStatements,
} from "#db/registration-notification-work.ts";
import { completePaidBooking } from "#routes/api/payment-processing/completion.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { bookedLine, bookingIntent } from "./index/helpers.ts";

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

describeWithEnv(
  "finishing off a booking that has been paid",
  { db: true },
  () => {
    const fetch = stubFetchEachTest(() => new Response());

    /** The work row the creation batch births beside every booking: the
     * completion claims it, so a direct completion call seeds one first. */
    const seedWork = async (sessionId: string): Promise<void> => {
      const prepared = await prepareRegistrationWork(sessionId, {
        ticketToken: "tok_seeded",
      });
      for (const { sql, args } of registrationWorkStatements(prepared, "")) {
        await execute(sql, args);
      }
    };

    test("hands back the first line's booking, listing, and tickets", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("First Line");
      await seedWork("cs_completion_first_line");

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

    test("answers retryably when another delivery holds the lease", async () => {
      const { entry } = await bookedLine("Held Line");
      const sessionId = "cs_completion_held";
      const prepared = await prepareRegistrationWork(sessionId, {
        ticketToken: "tok_seeded",
      });
      for (const { sql, args } of registrationWorkStatements(prepared, "")) {
        await execute(sql, args);
      }
      // A competing delivery claimed the row and holds its lease. The held
      // lease is not a finished tail, so this delivery must not answer
      // success and stop the provider's retries.
      await execute(
        "UPDATE registration_notification_work SET claimed_at = ? WHERE session_index = ?",
        [new Date().toISOString(), await hmacHash(sessionId)],
      );

      const result = await completePaidBooking(
        [entry],
        bareIntent(),
        [],
        [],
        ["tok_a"],
        noPackageFacts(),
        sessionId,
      );
      if (result.success) throw new Error("the held lease answered success");
      expect(result.status).toBe(409);
      // The held delivery notified nothing: no send left this process.
      expect(fetch.calls.length).toBe(0);
    });

    test("answers about the first line even when several were booked", async () => {
      // The buyer gets one thank-you page, and it is the first line's.
      const first = await bookedLine("Leading Line");
      const second = await bookedLine("Trailing Line");
      await seedWork("cs_completion_several_lines");

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
      await seedWork("cs_completion_saves_answers");

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

      await seedWork("cs_completion_promo_code");
      // One write records the answers at booking, one claims the
      // notification work, one logs the activity, one marks it delivered.
      const calls = await countDatabaseCalls(4, () =>
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

      expect(calls).toBe(4);
      expect(await logMentions("Promo code 'Ten off' used")).toBe(true);
    });

    test("writes down no code when the buyer used none", async () => {
      const { entry } = await bookedLine("Codeless Line");
      await seedWork("cs_completion_no_code");

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

      await seedWork("cs_completion_package_facts");
      // One write records the answers at booking, one claims the
      // notification work, one logs the activity, one marks it delivered.
      const calls = await countDatabaseCalls(4, () =>
        withRequestContext(() =>
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
      expect(calls).toBe(4);
    });
  },
);
