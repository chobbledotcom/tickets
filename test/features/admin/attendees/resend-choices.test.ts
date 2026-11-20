/**
 * Re-sending an attendee's notification: which sides each send choice sends
 * and settles, which presses the page refuses and with what words, and what a
 * failed press leaves behind.
 */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { execute } from "#db/client.ts";
import { sql, sqlLiteral, sqlName } from "#db/sql.ts";
import { withErrorSpy } from "#test/shared/webhook/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectIncludesAll,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import {
  emptyBookingLine,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendeeWithFlags,
  readPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { postListingSale, refundBookedOrder } from "#test-utils/ledger.ts";
import { adminGet } from "#test-utils/session.ts";
import { bookWebhookBuyer, expectResendPress, resend } from "./resend-press.ts";

describeWithEnv("re-sending a notification", { db: true }, () => {
  const fetch = stubFetchEachTest(() => new Response("{}"));
  const hookUrl = "https://hook.example.com/registration";

  /** The press, refused: the flash it answers with and no request sent. */
  const expectRefusedPress = async (
    attendeeId: number,
    name: string,
    sides: string | undefined,
    message: string,
  ): Promise<void> => {
    const before = fetch.calls.length;
    const { response } = await resend(attendeeId, name, sides);
    expectRedirectWithFlash(
      `/admin/attendees/${attendeeId}/actions`,
      message,
      false,
    )(response);
    expect(fetch.calls).toHaveLength(before);
  };

  test("offers the webhook choices only when the listing has a webhook", async () => {
    const plain = await setupListingAndAttendee({ name: "No Hook Page" });
    const hooked = await setupListingAndAttendee({
      listing: { webhookUrl: hookUrl },
      name: "Hook Page",
    });

    const pages: string[] = [];
    for (const { attendee } of [plain, hooked]) {
      const page = await adminGet(
        `/admin/attendees/${attendee.id}/resend-notification`,
      );
      expect(page.status).toBe(200);
      pages.push(await page.text());
    }

    expect(pages[0]).not.toContain('type="radio" value="webhooks"');
    expectIncludesAll(pages[1]!, [
      'name="resendSides" type="radio" value="webhooks"',
      'name="resendSides" type="radio" value="both"',
    ]);
  });

  const sideCases = [
    {
      counts: { buyerEmails: 1, webhooks: 0 },
      flags: { email: 0, webhooks: 1 },
      sides: "email",
    },
    {
      counts: { buyerEmails: 0, webhooks: 1 },
      flags: { email: 1, webhooks: 0 },
      sides: "webhooks",
    },
    {
      counts: { buyerEmails: 1, webhooks: 1 },
      flags: { email: 0, webhooks: 0 },
      sides: "both",
    },
  ] as const;

  for (const { counts, flags, sides } of sideCases) {
    test(`the "${sides}" choice sends those sides and settles only them`, async () => {
      await configureTestEmail();
      const { attendee } = await bookWebhookBuyer(`Chose ${sides}`, 1, 1);

      const { response } = await resend(attendee.id, `Chose ${sides}`, sides);

      await expectResendPress(
        response,
        attendee.id,
        counts,
        flags,
        fetch.calls,
      );
    });
  }

  test("an email choice needs no webhook on the listing", async () => {
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Mail Only", 1, 0);

    const { response } = await resend(attendee.id, "Mail Only", "email");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 0 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("no choice sends the email, keeps an owed webhook badge, and is logged", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Default Choice", 0, 1);

    const { response } = await resend(attendee.id, "Default Choice");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 0 },
      { email: 0, webhooks: 1 },
      fetch.calls,
    );
    assertArrayIncludes(await activityMessages(), [
      "Notification re-sent for attendee 'Default Choice'",
    ]);
  });

  for (const sides of ["", "pigeon"]) {
    test(`refuses the choice "${sides}" that the form never offers`, async () => {
      const { attendee } = await bookTestAttendeeWithFlags("Odd Press", 1, 0);

      await expectRefusedPress(
        attendee.id,
        "Odd Press",
        sides,
        "That choice is not valid. Reload the page and try again",
      );
    });
  }

  test("refuses a webhook choice when the listing has no webhook", async () => {
    const { attendee } = await bookTestAttendeeWithFlags("No Hook Press", 1, 1);

    await expectRefusedPress(
      attendee.id,
      "No Hook Press",
      "webhooks",
      "This attendee has no webhook to send",
    );
  });

  test("refuses a line with no places", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Gave It Up",
    });
    await emptyBookingLine(listing.id, attendee.id);

    await expectRefusedPress(
      attendee.id,
      "Gave It Up",
      undefined,
      "Cannot re-send a notification for a no-quantity line",
    );
  });

  test("refuses a purchase that was refunded", async () => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 300, quantity: 1 }],
      email: "refunded@example.com",
      name: "Refunded Buyer",
    });
    if (!made.success) throw new Error("Expected the booking to work");
    const attendee = made.attendees[0]!;
    const sale = { attendeeId: attendee.id, gross: 300, listingId: listing.id };
    await postListingSale(sale);
    await refundBookedOrder(attendee.id, listing.id);

    await expectRefusedPress(
      attendee.id,
      "Refunded Buyer",
      undefined,
      "Cannot re-send a notification for a refunded purchase",
    );
  });

  /** Run a press that fails on its activity write, optionally with the flag
   * release refused as well, and drop the triggers afterwards. */
  const failedPress = async (
    attendeeId: number,
    name: string,
    refuseRelease: boolean,
  ): Promise<void> => {
    const id = sqlLiteral(attendeeId);
    try {
      await execute(
        sql`CREATE TRIGGER reject_resend_activity BEFORE INSERT ON activity_log
       WHEN NEW.attendee_id = ${id}
       BEGIN
         SELECT RAISE(ABORT, 'activity rejected');
       END`,
      );
      if (refuseRelease) {
        await execute(
          sql`CREATE TRIGGER reject_flag_restore BEFORE UPDATE ON attendees
       WHEN NEW.id = ${id}
         AND (NEW.email_pending > OLD.email_pending
           OR NEW.webhooks_pending > OLD.webhooks_pending)
       BEGIN
         SELECT RAISE(ABORT, 'restore rejected');
       END`,
        );
      }
      await expect(resend(attendeeId, name, "both")).rejects.toThrow(
        "activity rejected",
      );
    } finally {
      for (const trigger of ["reject_resend_activity", "reject_flag_restore"]) {
        await execute(sql`DROP TRIGGER IF EXISTS ${sqlName(trigger)}`);
      }
    }
  };

  test("a failed send gives the claimed flags back", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Failed Send", 2, 1);

    await failedPress(attendee.id, "Failed Send", false);

    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 2,
      webhooks: 1,
    });
  });

  test("names a failed flag release in the error log", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Failed Release", 2, 1);

    const logs = await withErrorSpy(async (errorSpy) => {
      await failedPress(attendee.id, "Failed Release", true);
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expectIncludesAll(logs.join("\n"), [
      "Restoring a recovery's claimed flags failed",
    ]);
  });
});
