/**
 * Saving an edit: what an editor may not change, what a longer stay does to
 * the bookings already taken, and what the operator is told afterwards.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeUpdate } from "#db/client.ts";
import {
  getListingWithCount,
  getStoredListingWithCount,
} from "#db/listings/records.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirect, parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildUpdateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  adminMultipartPost,
  createTestEditorSession,
  testCsrfToken,
} from "#test-utils/session.ts";

/** The message the operator sees after the save, without its flash wrapper. */
const flashOf = (response: Response): string | undefined =>
  parseFlashCookie(response).success;

const editAs = async (
  cookie: string,
  id: number,
  values: TestFormValues,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return await handleRequest(
    mockMultipartRequest(
      `/admin/listing/${id}/edit`,
      { ...values, csrf_token: await testCsrfToken() },
      cookie,
    ),
  );
};

describeWithEnv("what an editor may not change", { db: true }, () => {
  test("leaves the stored webhook URL alone", async () => {
    const listing = await createTestListing({
      name: "Locked Webhook",
      webhookUrl: "https://owner.example.com/hook",
    });
    const { cookie } = await createTestEditorSession();

    await editAs(
      cookie,
      listing.id,
      buildUpdateListingForm(
        { webhookUrl: "https://attacker.example.com/steal" },
        listing,
      ),
    );

    expect((await getStoredListingWithCount(listing.id))!.webhook_url).toBe(
      "https://owner.example.com/hook",
    );
  });

  test("leaves the stored defaults flag alone", async () => {
    const listing = await createTestListing({
      name: "Locked Defaults",
      useDefaults: true,
    });
    const { cookie } = await createTestEditorSession();

    await editAs(
      cookie,
      listing.id,
      buildUpdateListingForm({ useDefaults: false }, listing),
    );

    expect((await getStoredListingWithCount(listing.id))!.use_defaults).toBe(
      true,
    );
  });

  test("cannot correct the ticket count a staff member can", async () => {
    const listing = await createTestListing({ name: "Aggregates" });
    const { cookie } = await createTestEditorSession();

    await editAs(cookie, listing.id, {
      ...buildUpdateListingForm({}, listing),
      booked_quantity: "7",
      tickets_count: "7",
    });

    expect((await getListingWithCount(listing.id))!.tickets_count).toBe(0);

    await adminMultipartPost(`/admin/listing/${listing.id}/edit`, {
      ...buildUpdateListingForm({}, listing),
      booked_quantity: "7",
      tickets_count: "7",
    });

    expect((await getListingWithCount(listing.id))!.tickets_count).toBe(7);
  });
});

describeWithEnv("what a saved edit says afterwards", { db: true }, () => {
  test("records the change in the activity log", async () => {
    const listing = await createTestListing({ name: "Before Log" });

    await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ name: "After Log" }, listing),
    );

    expect(await activityMessages()).toContain("Listing 'After Log' updated");
  });

  test("says only that the listing was updated when nothing else changed", async () => {
    const listing = await createTestListing({ name: "Quiet Save" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ name: "Quiet Saved" }, listing),
    );

    expectRedirect(response);
    expect(flashOf(response)).toBe("Listing updated");
  });

  test("re-opens the Edit tab with the message when the save is refused", async () => {
    const listing = await createTestListing({ name: "Refused" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      { ...buildUpdateListingForm({}, listing), name: "" },
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(
      `<a aria-current="page" class="active" href="/admin/listing/${listing.id}/edit">Edit</a>`,
    );
    expect(html).toContain("Listing name is required");
  });
});

describeWithEnv("changing how long a daily stay runs", { db: true }, () => {
  const dailyListing = (overrides: Record<string, unknown> = {}) =>
    createDailyTestListing({
      durationDays: 2,
      maxAttendees: 100,
      maximumDaysAfter: 100,
      name: "Retreat",
      ...overrides,
    });

  test("recomputes the bookings already taken and logs it", async () => {
    const listing = await dailyListing();
    const booked = await bookAttendee(listing, { date: "2026-09-01" });
    if (!booked.success) throw new Error("Expected the booking to succeed");

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ durationDays: 4 }, listing),
    );

    expect(flashOf(response)).toBe("Listing updated");
    expect(await activityMessages()).toContain(
      "Listing 'Retreat' duration changed to 4 day(s)",
    );
  });

  test("leaves the bookings alone when the length did not move", async () => {
    const listing = await dailyListing({ name: "Same Length" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ maxAttendees: 90 }, listing),
    );

    expect(flashOf(response)).toBe("Listing updated");
    expect(await activityMessages()).not.toContain(
      "Listing 'Same Length' duration changed to 2 day(s)",
    );
  });

  test("leaves a visitor-chosen stay alone, because the number is only a maximum", async () => {
    const listing = await dailyListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      name: "Chosen Length",
    });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ durationDays: 5 }, listing),
    );

    expect(flashOf(response)).toBe("Listing updated");
    expect(await activityMessages()).not.toContain(
      "Listing 'Chosen Length' duration changed to 5 day(s)",
    );
  });

  test("warns about the shared day a longer stay pushes over its group's limit", async () => {
    // Two stays share a capped group. The first runs one day; stretching it to
    // three makes it overlap the second on the day after, and the pair no
    // longer fits under the cap.
    // The cap goes on after the bookings, because a capped group would refuse
    // the second one at the door and there would be nothing to overflow.
    const group = await createTestGroup({ maxAttendees: 0, name: "Shared" });
    const stretched = await dailyListing({
      durationDays: 1,
      groupId: group.id,
      name: "Stretched",
    });
    const neighbour = await dailyListing({
      durationDays: 1,
      groupId: group.id,
      name: "Neighbour",
    });
    await bookAttendee(stretched, { date: "2026-09-01", quantity: 6 });
    await bookAttendee(neighbour, { date: "2026-09-02", quantity: 6 });
    await executeUpdate("groups", { max_attendees: 10 }, { id: group.id });

    const { response } = await adminMultipartPost(
      `/admin/listing/${stretched.id}/edit`,
      {
        ...buildUpdateListingForm({ durationDays: 3 }, stretched),
        group_ids: String(group.id),
      },
    );

    expect(flashOf(response)).toBe(
      "Listing updated Warning: group capacity exceeded on 2026-09-02",
    );
    expect(await activityMessages()).toContain(
      "Duration change caused group capacity overflow on 2026-09-02",
    );
  });

  test("says nothing extra for a listing that is not daily", async () => {
    const listing = await createTestListing({ name: "Standard" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ durationDays: 3 }, listing),
    );

    expect(flashOf(response)).toBe("Listing updated");
  });
});
