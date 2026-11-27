/** Re-sending a booking notification renders the buyer's free-text answers
 * as they stand now, a booking answer and each ticket's answer alike. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sql } from "#db/sql.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  submitAttendeeEdit,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { runWrite } from "#test-utils/raw-db.ts";
import { expectOwedResend } from "./resend-press.ts";

describeWithEnv(
  "re-sending with a buyer's free-text answer",
  { db: true },
  () => {
    const fetch = stubFetchEachTest(() => new Response("{}"));

    /** The confirmation texts sent to this buyer, in send order. */
    const buyerEmailTexts = (buyer: string): string[] =>
      fetch.calls.flatMap(({ args }) => {
        const [, options] = args as [string, RequestInit];
        const body = JSON.parse(options.body as string) as {
          to?: string[];
          text?: string;
        };
        return body.to?.[0] === buyer && body.text !== undefined
          ? [body.text]
          : [];
      });

    test("renders the free-text answer as it stands now", async () => {
      await configureTestEmail();
      const listing = await createTestListing({ maxAttendees: 100 });
      const questionId = await createFreeTextQuestion([listing.id]);
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Current Wording",
        "wording@example.com",
        1,
        "",
        { [`question${questionId}`]: "Coming by bus" },
      );
      const edited = await submitAttendeeEdit(attendee.id, {
        email: "wording@example.com",
        extra: { [`question${questionId}`]: "Coming by train" },
        name: "Current Wording",
      });
      expect(edited.status).toBe(302);

      await expectOwedResend(attendee.id, "Current Wording");
      const resent = buyerEmailTexts("wording@example.com").at(-1);
      assertStringIncludes(resent ?? "", "Anything else?: Coming by train");
      assert(!(resent ?? "").includes("Coming by bus"));
    });

    test("renders each ticket's answer under its line and ticket", async () => {
      await configureTestEmail();
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
        name: "Disco A",
      });
      const { question } = await seedListingLevelQuestion(
        [listing.id],
        "Pupil name",
        "quantity",
      );
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ticket Buyer",
        "tickets@example.com",
        2,
        "",
        {
          [`question${question.id}_line${listing.id}_0_0_ticket0`]: "Ava",
          [`question${question.id}_line${listing.id}_0_0_ticket1`]: "Amy",
        },
      );

      await expectOwedResend(attendee.id, "Ticket Buyer");
      expectIncludesAll(buyerEmailTexts("tickets@example.com").at(-1) ?? "", [
        "Pupil name (Disco A, ticket 1): Ava",
        "Pupil name (Disco A, ticket 2): Amy",
      ]);
    });

    test("leaves out the answer of a ticket the buyer no longer holds", async () => {
      await configureTestEmail();
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
        name: "Disco A",
      });
      const { question } = await seedListingLevelQuestion(
        [listing.id],
        "Pupil name",
        "quantity",
      );
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Fewer Tickets",
        "fewer@example.com",
        2,
        "",
        {
          [`question${question.id}_line${listing.id}_0_0_ticket0`]: "Ava",
          [`question${question.id}_line${listing.id}_0_0_ticket1`]: "Amy",
        },
      );
      await runWrite(
        sql`UPDATE listing_attendees SET quantity = 1 WHERE attendee_id = ${attendee.id}`,
      );

      await expectOwedResend(attendee.id, "Fewer Tickets");
      const resent = buyerEmailTexts("fewer@example.com").at(-1) ?? "";
      assertStringIncludes(resent, "Pupil name (Disco A, ticket 1): Ava");
      assert(!resent.includes("Amy"));
    });
  },
);
