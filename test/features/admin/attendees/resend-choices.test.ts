/**
 * Re-sending an attendee's notification: which sides each send choice sends
 * and settles, which presses the page refuses and with what words, and what a
 * failed press leaves behind.
 */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
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
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { refundBookedOrder } from "#test-utils/ledger.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  bookWebhookBuyer,
  expectPressWithRefusedActivity,
  expectResendPress,
  resend,
} from "./resend-press.ts";

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

  /* jscpd:ignore-start -- static data, not code */
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
  /* jscpd:ignore-end */

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
    const attendee = bookedAttendee(
      await bookAttendee(listing, {
        email: "refunded@example.com",
        name: "Refunded Buyer",
        pricePaid: 300,
        quantity: 1,
      }),
    );
    await refundBookedOrder(attendee.id, listing.id);

    await expectRefusedPress(
      attendee.id,
      "Refunded Buyer",
      undefined,
      "Cannot re-send a notification for a refunded purchase",
    );
  });

  test("a failed send gives the claimed flags back", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Failed Send", 2, 1);

    await expectPressWithRefusedActivity(attendee.id, "Failed Send", {
      email: 2,
      webhooks: 1,
    });
  });
});
