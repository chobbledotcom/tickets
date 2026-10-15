/**
 * Which booking source a re-send's webhook reports.
 *
 * The re-send reads the source the original booking stored in its contact
 * history, not who pressed the button. A contact channel an admin edit adds
 * inherits the stored source, so the report stays the original booking's.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { execute } from "#db/client.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  markNotificationSendsOwed,
  submitAttendeeEdit,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { adminFormPost } from "#test-utils/session.ts";

const resend = async (attendeeId: number, name: string) => {
  await markNotificationSendsOwed(attendeeId);
  return adminFormPost(`/admin/attendees/${attendeeId}/resend-notification`, {
    confirm_identifier: name,
  });
};

describeWithEnv("the booking source a re-send reports", { db: true }, () => {
  const WEBHOOK_URL = "https://example.com/registration";
  const fetch = stubFetchEachTest(() => new Response("{}"));

  /** The registration webhook body a call posted, if any. */
  const postedWebhookBody = (
    after: number,
  ): {
    notification_type: string;
    source: string;
  } | null => {
    const call = fetch.calls
      .slice(after)
      .find((one) => one.args[0] === WEBHOOK_URL);
    if (!call) return null;
    const [, options] = call.args as [string, RequestInit];
    return JSON.parse(options.body as string) as {
      notification_type: string;
      source: string;
    };
  };

  test("a booking made online reports public", async () => {
    const { attendee } = await setupListingAndAttendee({
      listing: { name: "Online Source", webhookUrl: WEBHOOK_URL },
      name: "Online Buyer",
    });
    // The original booking fired its own webhook; only the re-send's counts.
    const before = fetch.calls.length;

    await resend(attendee.id, "Online Buyer");

    expect(postedWebhookBody(before)?.source).toBe("public");
  });

  test("a booking an admin added reports admin", async () => {
    const listing = await createTestListing({
      name: "Admin Source",
      webhookUrl: WEBHOOK_URL,
    });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "walkin@example.com",
      name: "Walk In",
      source: "admin",
    });
    if (!made.success) throw new Error("Expected the manual add to work");
    const before = fetch.calls.length;

    await resend(made.attendees[0]!.id, "Walk In");

    expect(postedWebhookBody(before)?.source).toBe("admin");
  });

  test("a phone-only online booking reports public after an admin adds the email", async () => {
    const listing = await createTestListing({
      name: "Phone Then Email",
      webhookUrl: WEBHOOK_URL,
    });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "",
      name: "Phone Buyer",
      phone: "+447700900123",
      source: "public",
    });
    if (!made.success) throw new Error("Expected the booking to work");
    const attendee = made.attendees[0]!;
    await submitAttendeeEdit(attendee.id, {
      email: "phone-buyer@example.com",
      name: "Phone Buyer",
      phone: "+447700900123",
    });
    const before = fetch.calls.length;

    await resend(attendee.id, "Phone Buyer");

    const body = postedWebhookBody(before);
    expect(body?.notification_type).toBe("registration.completed");
    expect(body?.source).toBe("public");
  });

  test("a booking with no contact history reports unknown", async () => {
    const { attendee } = await setupListingAndAttendee({
      listing: { name: "Historyless", webhookUrl: WEBHOOK_URL },
      name: "No History",
    });
    await execute("DELETE FROM contact_preferences");
    const before = fetch.calls.length;

    await resend(attendee.id, "No History");

    expect(postedWebhookBody(before)?.source).toBe("unknown");
  });
});
