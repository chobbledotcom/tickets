/**
 * The attendee actions bound to a listing's roster: checking someone in and
 * out, adding one by hand, and clearing an incomplete payment. Each returns
 * the operator to the tab the form lives on, so the row they acted on is in
 * view with the confirmation.
 */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryOne } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  adminCheckinPost as checkIn,
  setupListingAndAttendee,
  submitDeleteIncomplete,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  decryptFirstAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  adminFormPost,
  getTestSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";

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
    const phoneOnly = await createTestListing({ fields: "phone" });
    const emailOnly = await createTestListing({ fields: "email" });

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
  const day = (stamp: string | null | undefined) => stamp?.slice(0, 10) ?? null;
  const daily = { maxAttendees: 10, maximumDaysAfter: 100 };
  const nights = { end: "2026-09-03", start: "2026-09-01" };

  const stayCases = [
    {
      form: { date: "2026-09-01" },
      listing: () => createDailyTestListing({ ...daily, durationDays: 2 }),
      name: "a daily listing books its own length",
      stay: nights,
    },
    {
      form: { date: "2026-09-01", dayCount: "2" },
      listing: () =>
        createDailyTestListing({
          ...daily,
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
          durationDays: 3,
        }),
      name: "a daily listing that lets the operator choose books the chosen length",
      stay: nights,
    },
    {
      form: {},
      listing: () =>
        createTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
          maxAttendees: 10,
        }),
      name: "a standard listing flagged for choosing books no day",
      stay: { end: null, start: null },
    },
  ];

  for (const { form, listing: makeListing, name, stay } of stayCases) {
    test(name, async () => {
      const listing = await makeListing();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee`,
        {
          email: "stay@example.com",
          name: "Stay Guest",
          quantity: "1",
          ...form,
        },
      );

      expectRedirectWithFlash(
        `/admin/listing/${listing.id}/attendees`,
        "Added Stay Guest",
      )(response);
      const line = await queryOne<{
        start_at: string | null;
        end_at: string | null;
      }>(
        sql`SELECT start_at, end_at FROM listing_attendees WHERE listing_id = ${listing.id}`,
      );
      expect({ end: day(line?.end_at), start: day(line?.start_at) }).toEqual(
        stay,
      );
    });
  }
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
