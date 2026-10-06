import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
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
    stubFetchEachTest(() => new Response());

    test("hands back the first line's booking, listing, and tickets", async () => {
      const { attendeeId, entry, listingId } = await bookedLine("First Line");

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

      // One write records the answers at booking, one logs the activity.
      const calls = await countDatabaseCalls(2, () =>
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

      expect(calls).toBe(2);
      expect(await logMentions("Promo code 'Ten off' used")).toBe(true);
    });

    test("writes down no code when the buyer used none", async () => {
      const { entry } = await bookedLine("Codeless Line");

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

      const calls = await countDatabaseCalls(2, () =>
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
      expect(calls).toBe(2);
    });
  },
);
