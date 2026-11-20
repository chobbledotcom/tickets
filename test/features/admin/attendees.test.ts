/**
 * The attendee actions bound to a listing's roster: checking someone in and
 * out, adding one by hand, and clearing an incomplete payment. Each returns
 * the operator to the tab the form lives on, so the row they acted on is in
 * view with the confirmation.
 */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { execute, getDb, queryOne } from "#db/client.ts";
import { sql, sqlLiteral, sqlName } from "#db/sql.ts";
import { t } from "#i18n";
import { withErrorSpy } from "#test/shared/webhook/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectIncludesAll,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import {
  adminCheckinPost as checkIn,
  emptyBookingLine,
  setupListingAndAttendee,
  submitDeleteIncomplete,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookTestAttendeeWithFlags,
  decryptFirstAttendee,
  getAttendeesRaw,
  readPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { postListingSale, refundBookedOrder } from "#test-utils/ledger.ts";
import {
  adminFormPost,
  adminGet,
  getTestSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";
import {
  bookWebhookBuyer,
  expectResendPress,
  resend,
} from "./attendees/resend-press.ts";

/** Whether the roster row for one attendee on one listing is checked in. */
const isCheckedIn = async (
  listingId: number,
  attendeeId: number,
): Promise<boolean> => {
  const rows = await getDb().execute(
    sql`SELECT checked_in FROM listing_attendees WHERE listing_id = ${listingId} AND attendee_id = ${attendeeId}`,
  );
  return Number(rows.rows[0]!.checked_in) === 1;
};

describeWithEnv("checking an attendee in", { db: true }, () => {
  test("marks them in, then out again on a second press", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Ada Lovelace",
    });

    await checkIn(listing.id, attendee.id);
    const afterIn = await isCheckedIn(listing.id, attendee.id);
    // The roster's Check Out button names its direction, so a bare POST is
    // always a check-in now.
    await checkIn(listing.id, attendee.id, { checkIn: "false" });
    const afterOut = await isCheckedIn(listing.id, attendee.id);

    expect(afterIn).toBe(true);
    expect(afterOut).toBe(false);
  });

  test("returns to the roster, keeping the filter it came from", async () => {
    // The roster's form threads its filtered view through, so the operator
    // lands back on the list they were working through.
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Grace Hopper",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      returnFilter: "out",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees?filter=out`,
      "Checked Grace Hopper in",
    )(response);
  });

  test("returns where the form asked when it named a page", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Alan Turing",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      returnUrl: `/admin/listing/${listing.id}/scanner`,
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/scanner`,
      "Checked Alan Turing in",
    )(response);
  });
});

describeWithEnv("adding an attendee by hand", { db: true }, () => {
  test("adds them and lands on the roster they were added to", async () => {
    const { listing } = await setupListingAndAttendee({ name: "Existing" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "new@example.com", name: "Added By Hand", quantity: "1" },
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Added Added By Hand",
    )(response);
  });

  test("owes the email the listing collects, and no webhooks", async () => {
    // A hand-added attendee never gets an email from the add itself, so the
    // email flag stays up until a Re-send notification is accepted. Webhooks
    // are never owed for a hand-added attendee.
    const { listing } = await setupListingAndAttendee({
      listing: { fields: "email", webhookUrl: "https://hooks.example.com/x" },
      name: "Existing",
    });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "owed@example.com", name: "Owed Email", quantity: "1" },
    );

    expect(response.status).toBe(302);
    const row = await queryOne<{
      email_pending: number;
      webhooks_pending: number;
    }>(
      sql`SELECT email_pending, webhooks_pending FROM attendees
       WHERE id = (SELECT MAX(attendee_id) FROM listing_attendees WHERE listing_id = ${listing.id})`,
    );
    expect(row).toEqual({ email_pending: 2, webhooks_pending: 0 });
  });

  test("owes no email when the listing collects none", async () => {
    const { listing } = await setupListingAndAttendee({ name: "Existing" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { name: "No Email Owed", quantity: "1" },
    );

    expect(response.status).toBe(302);
    const row = await queryOne<{ email_pending: number }>(
      sql`SELECT email_pending FROM attendees
       WHERE id = (SELECT MAX(attendee_id) FROM listing_attendees WHERE listing_id = ${listing.id})`,
    );
    expect(row).toEqual({ email_pending: 0 });
  });

  test("refuses more places than the listing has left", async () => {
    const { listing } = await setupListingAndAttendee({
      listing: { maxAttendees: 1 },
      name: "Took The Only Place",
    });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "late@example.com", name: "Too Late", quantity: "1" },
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      t("error.not_enough_spots"),
      false,
    )(response);
  });

  test("turns a form with no name away with the reason", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "nameless@example.com", quantity: "1" },
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      expect.stringContaining("required"),
      false,
    )(response);
  });

  test("writes the addition in the listing's history", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    await adminFormPost(`/admin/listing/${listing.id}/attendee`, {
      email: "logged@example.com",
      name: "Written Down",
      quantity: "1",
    });

    assertArrayIncludes(await activityMessages(), [
      "Attendee 'Written Down' added manually",
    ]);
  });

  test("stores the details the listing never asked for as empty", async () => {
    const phoneOnly = await createTestListing({
      fields: "phone",
      maxAttendees: 10,
    });
    const emailOnly = await createTestListing({
      fields: "email",
      maxAttendees: 10,
    });

    await adminFormPost(`/admin/listing/${phoneOnly.id}/attendee`, {
      name: "Phone Guest",
      phone: "07700900123",
      quantity: "1",
    });
    await adminFormPost(`/admin/listing/${emailOnly.id}/attendee`, {
      email: "mail@example.com",
      name: "Mail Guest",
      quantity: "1",
    });

    expect(await decryptFirstAttendee(phoneOnly.id)).toMatchObject({
      address: "",
      email: "",
      phone: "07700900123",
      special_instructions: "",
    });
    expect(await decryptFirstAttendee(emailOnly.id)).toMatchObject({
      address: "",
      email: "mail@example.com",
      phone: "",
      special_instructions: "",
    });
  });
});

describeWithEnv("the days an added attendee stays", { db: true }, () => {
  const day = (stamp: string | null | undefined) =>
    stamp?.slice(0, 10) ?? null;

  /** The stored start and end day of the one booking line on a listing. */
  const stay = async (listingId: number) => {
    const line = await queryOne<{
      start_at: string | null;
      end_at: string | null;
    }>(
      sql`SELECT start_at, end_at FROM listing_attendees WHERE listing_id = ${listingId}`,
    );
    return { end: day(line?.end_at), start: day(line?.start_at) };
  };

  const dayPrices = { 1: 1000, 2: 1800, 3: 2500 };

  test("uses the listing's own length on a daily listing", async () => {
    const listing = await createDailyTestListing({
      durationDays: 2,
      maxAttendees: 10,
      maximumDaysAfter: 100,
    });

    await adminFormPost(`/admin/listing/${listing.id}/attendee`, {
      date: "2026-09-01",
      email: "two@example.com",
      name: "Two Nights",
      quantity: "1",
    });

    expect(await stay(listing.id)).toEqual({
      end: "2026-09-03",
      start: "2026-09-01",
    });
  });

  test("uses the length chosen when a daily listing lets the operator choose", async () => {
    const listing = await createDailyTestListing({
      customisableDays: true,
      dayPrices,
      durationDays: 3,
      maxAttendees: 10,
      maximumDaysAfter: 100,
    });

    await adminFormPost(`/admin/listing/${listing.id}/attendee`, {
      date: "2026-09-01",
      dayCount: "2",
      email: "choice@example.com",
      name: "Two Of Three",
      quantity: "1",
    });

    expect(await stay(listing.id)).toEqual({
      end: "2026-09-03",
      start: "2026-09-01",
    });
  });

  test("books no day on a standard listing, even one flagged for choosing", async () => {
    const listing = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      maxAttendees: 10,
    });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "flat@example.com", name: "Flat Booking", quantity: "1" },
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Added Flat Booking",
    )(response);
    expect(await stay(listing.id)).toEqual({ end: null, start: null });
  });
});

describeWithEnv("clearing an incomplete payment", { db: true }, () => {
  test("refuses when the attendee's payment is not incomplete", async () => {
    // The free booking above paid nothing to leave incomplete, so the action
    // has nothing to clear and says so instead of deleting the row.
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Fully Booked",
    });

    const { cookie, csrfToken } = await getTestSession();
    const response = await submitDeleteIncomplete(
      listing.id,
      attendee.id,
      cookie,
      csrfToken,
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      t("error.attendee_no_incomplete_payment"),
      false,
    )(response);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
  });

  test("removes a payment that never completed and says so", async () => {
    const { listing } = await setupListingAndLogin({
      maxAttendees: 100,
      name: "Paid Listing",
      unitPrice: 1000,
    });
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Never Paid",
      "stuck@example.com",
      "",
      1000,
    );
    const { cookie, csrfToken } = await getTestSession();

    const response = await submitDeleteIncomplete(
      listing.id,
      attendee.id,
      cookie,
      csrfToken,
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Incomplete registration removed",
    )(response);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
  });
});

describeWithEnv("the re-send page's webhook choice", { db: true }, () => {
  const pageHtml = async (attendeeId: number): Promise<string> => {
    const response = await adminGet(
      `/admin/attendees/${attendeeId}/resend-notification`,
    );
    expect(response.status).toBe(200);
    return response.text();
  };

  test("offers the webhook choices only when the listing has a webhook", async () => {
    const plain = await setupListingAndAttendee({ name: "No Hook Page" });
    const hooked = await setupListingAndAttendee({
      listing: { webhookUrl: "https://hook.example.com/registration" },
      name: "Hook Page",
    });

    const plainHtml = await pageHtml(plain.attendee.id);
    const hookedHtml = await pageHtml(hooked.attendee.id);

    expect(plainHtml).not.toContain('type="radio" value="webhooks"');
    expectIncludesAll(hookedHtml, [
      'name="resendSides" type="radio" value="webhooks"',
      'name="resendSides" type="radio" value="both"',
    ]);
  });
});

describeWithEnv("re-sending a notification", { db: true }, () => {
  const fetch = stubFetchEachTest(() => new Response("{}"));
  const actionsTab = (attendeeId: number) =>
    `/admin/attendees/${attendeeId}/actions`;

  /** The press, and the page and flash it must answer with when refused. */
  const expectRefusedPress = async (
    attendeeId: number,
    name: string,
    sides: string | undefined,
    message: string,
  ): Promise<void> => {
    const { response } = await resend(attendeeId, name, sides);
    expectRedirectWithFlash(actionsTab(attendeeId), message, false)(response);
    expect(fetch.calls).toHaveLength(0);
  };

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

      await expectResendPress(response, attendee.id, counts, flags, fetch.calls);
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

  test("a press with no choice sends the email and keeps an owed webhook badge", async () => {
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
    test(`refuses the choice "${sides}" the form never offers`, async () => {
      const { attendee } = await bookTestAttendeeWithFlags("Odd Press", 1, 0);

      await expectRefusedPress(
        attendee.id,
        "Odd Press",
        sides,
        "That choice is not valid. Reload the page and try again",
      );
      expect(await readPendingNotificationFlags(attendee.id)).toEqual({
        email: 1,
        webhooks: 0,
      });
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
    await postListingSale({
      attendeeId: attendee.id,
      gross: 300,
      listingId: listing.id,
    });
    await refundBookedOrder(attendee.id, listing.id);

    await expectRefusedPress(
      attendee.id,
      "Refunded Buyer",
      undefined,
      "Cannot re-send a notification for a refunded purchase",
    );
  });

  /** Refuse every activity write for one attendee, plus any extra trigger. */
  const withRefusedActivity = async (
    attendeeId: number,
    extra: string[],
    run: () => Promise<void>,
  ): Promise<void> => {
    await execute(
      sql`CREATE TRIGGER reject_resend_activity BEFORE INSERT ON activity_log
       WHEN NEW.attendee_id = ${sqlLiteral(attendeeId)}
       BEGIN
         SELECT RAISE(ABORT, 'activity rejected');
       END`,
    );
    try {
      for (const create of extra) await execute(sql`${sqlLiteral(create)}`);
      await run();
    } finally {
      await execute(sql`DROP TRIGGER IF EXISTS reject_resend_activity`);
      await execute(sql`DROP TRIGGER IF EXISTS ${sqlName("reject_flag_restore")}`);
    }
  };

  test("a failed send gives the claimed flags back", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Failed Send", 2, 1);

    await withRefusedActivity(attendee.id, [], async () => {
      await expect(resend(attendee.id, "Failed Send", "both")).rejects.toThrow(
        "activity rejected",
      );
    });

    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 2,
      webhooks: 1,
    });
  });

  test("names the failed flag release in the error log", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Failed Release", 2, 1);
    const restoreTrigger = `CREATE TRIGGER reject_flag_restore BEFORE UPDATE ON attendees
       WHEN NEW.id = ${attendee.id}
         AND (NEW.email_pending > OLD.email_pending
           OR NEW.webhooks_pending > OLD.webhooks_pending)
       BEGIN
         SELECT RAISE(ABORT, 'restore rejected');
       END`;

    const logs = await withErrorSpy(async (errorSpy) => {
      await withRefusedActivity(attendee.id, [restoreTrigger], async () => {
        await expect(
          resend(attendee.id, "Failed Release", "both"),
        ).rejects.toThrow("activity rejected");
      });
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expectIncludesAll(logs.join("\n"), [
      "Restoring a recovery's claimed flags failed",
      "restore rejected",
    ]);
  });
});
