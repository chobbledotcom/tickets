/** The edit save path directly: the role rule over submitted aggregates. The
 * route wiring has its own suite; this pins the role decision itself. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { recomputeListingBookingRanges } from "#db/attendees/update.ts";
import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { tables } from "#db/select/tables.ts";
import { update } from "#db/write.ts";
import {
  earliestGroupCapOverflow,
  handleListingEditSuccess,
  parseAggregatesForRole,
} from "#routes/admin/listings-edit-save.ts";
import { formDataToParams } from "#routes/csrf.ts";
import type { FormParams } from "#shared/form-data.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectIncludesAll,
  expectRedirect,
  parseFlashCookie,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { buildUpdateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminMultipartPost } from "#test-utils/session.ts";
import type { AdminSession } from "#types";

const sessionOf = (adminLevel: "owner" | "editor"): AdminSession =>
  ({ adminLevel }) as AdminSession;

/** An edit form's counters: both trigger-maintained fields always submit. */
const formWithAggregates = (
  bookedQuantity: string,
  ticketsCount: string,
): FormParams => {
  const body = new FormData();
  body.set("bookedQuantity", bookedQuantity);
  body.set("ticketsCount", ticketsCount);
  return formDataToParams(body);
};

describe("edit save path > aggregates by role", () => {
  test("an editor's crafted owner-level figures are ignored, never trusted", () => {
    const result = parseAggregatesForRole(
      sessionOf("editor"),
      formWithAggregates("99", "99"),
    );
    expect(result).toEqual({ input: null, ok: true });
  });

  test("staff submissions parse the editable aggregates", () => {
    const result = parseAggregatesForRole(
      sessionOf("owner"),
      formWithAggregates("12", "13"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ bookedQuantity: 12, ticketsCount: 13 });
    }
  });
});

const DAY_1 = "2026-09-01";
const DAY_2 = "2026-09-02";

describeWithEnv("db > edit save path duration warnings", { db: true }, () => {
  test("warns with the earliest overflow day across every group", async () => {
    // The day-later group carries the smaller id, so iteration meets its
    // overflow first: the warning must still name the earliest day.
    const dayLaterOverflow = await createTestGroup({ name: "Later overflow" });
    const dayEarlierOverflow = await createTestGroup({
      name: "Earlier overflow",
    });
    const target = await createDailyTestListing({
      groupId: dayLaterOverflow.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    await assignListingsToGroup([target.id], dayEarlierOverflow.id);
    const siblingLater = await createDailyTestListing({
      groupId: dayLaterOverflow.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    const siblingEarlier = await createDailyTestListing({
      groupId: dayEarlierOverflow.id,
      maxAttendees: 100,
      maximumDaysAfter: 100,
    });
    await bookAttendee(target, { date: DAY_1, quantity: 5 });
    await recomputeListingBookingRanges(target.id, 2);
    await bookAttendee(siblingLater, { date: DAY_2, quantity: 10 });
    await bookAttendee(siblingEarlier, { date: DAY_1, quantity: 10 });
    // createTestGroup's maxAttendees override does not survive the create
    // form, so the caps are set the way the edit path itself sets them.
    await execute(
      update(tables.groups, { maxAttendees: 10 }).where({
        id: dayLaterOverflow.id,
      }),
    );
    await execute(
      update(tables.groups, { maxAttendees: 10 }).where({
        id: dayEarlierOverflow.id,
      }),
    );

    expect(await earliestGroupCapOverflow(target.id)).toBe(DAY_1);
  });
});

type ListingOverrides = Parameters<typeof createTestListing>[0];

/** A two-day stay with room for every booking these tests make. */
const stay = (overrides: ListingOverrides) =>
  createDailyTestListing({
    durationDays: 2,
    maxAttendees: 100,
    maximumDaysAfter: 100,
    name: "Retreat",
    ...overrides,
  });

const saveEdit = (
  listing: { id: number },
  values: ReturnType<typeof buildUpdateListingForm>,
) => adminMultipartPost(`/admin/listing/${listing.id}/edit`, values);

describeWithEnv("db > edit save path outcomes", { db: true }, () => {
  for (const [label, create, updates] of [
    [
      "a listing that is not daily",
      () => createTestListing({ name: "Plain" }),
      { durationDays: 3 },
    ],
    [
      "a visitor-chosen stay",
      () =>
        stay({
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          name: "Chosen",
        }),
      { durationDays: 5 },
    ],
    [
      "a stay of the same length",
      () => stay({ name: "Same" }),
      { maxAttendees: 90 },
    ],
  ] as const) {
    test(`says only that the listing was updated for ${label}`, async () => {
      const listing = await create();

      const { response } = await saveEdit(
        listing,
        buildUpdateListingForm(updates, listing),
      );

      expect(parseFlashCookie(response).success).toBe("Listing updated");
      expect(expectRedirect(response)).toMatch(
        new RegExp(`^/admin/listing/${listing.id}\\b`),
      );
    });
  }

  test("logs a longer stay and adds no warning when every group fits", async () => {
    const listing = await stay({});

    const { response } = await saveEdit(
      listing,
      buildUpdateListingForm({ durationDays: 4 }, listing),
    );

    expect(parseFlashCookie(response).success).toBe("Listing updated");
    expect(await activityMessages()).toContain(
      "Listing 'Retreat' duration changed to 4 day(s)",
    );
    expect(
      (await activityMessages()).filter((one) => one.includes("overflow")),
    ).toEqual([]);
  });

  test("warns and logs when a longer stay overflows a group", async () => {
    const group = await createTestGroup({ maxAttendees: 0, name: "Shared" });
    const stretched = await stay({
      durationDays: 1,
      groupId: group.id,
      name: "Stretched",
    });
    const neighbour = await stay({
      durationDays: 1,
      groupId: group.id,
      name: "Neighbour",
    });
    await bookAttendee(stretched, { date: DAY_1, quantity: 6 });
    await bookAttendee(neighbour, { date: DAY_2, quantity: 6 });
    await execute(
      update(tables.groups, { maxAttendees: 10 }).where({ id: group.id }),
    );

    const { response } = await saveEdit(stretched, {
      ...buildUpdateListingForm({ durationDays: 3 }, stretched),
      groupIds: String(group.id),
    });

    expect(parseFlashCookie(response).success).toBe(
      `Listing updated Warning: group capacity exceeded on ${DAY_2}`,
    );
    const messages = await activityMessages();
    expect(messages).toContain(
      "Listing 'Stretched' duration changed to 3 day(s)",
    );
    expect(messages).toContain(
      `Duration change caused group capacity overflow on ${DAY_2}`,
    );
  });

  test("names the bookings that a confirmed switch moved", async () => {
    const listing = await createTestListing({ name: "Switched" });

    const response = await handleListingEditSuccess(
      listing,
      listing,
      null,
      new FormData(),
      listing.id,
      { count: 2, date: DAY_1 },
    );

    expect(parseFlashCookie(response).success).toBe(
      "Listing updated — 2 bookings were given 2026-09-01.",
    );
  });

  test("re-opens the Edit tab with the submitted groups when refused", async () => {
    const listing = await createTestListing({ name: "Refused" });
    const group = await createTestGroup({ name: "Chosen" });

    const { response } = await saveEdit(listing, {
      ...buildUpdateListingForm({}, listing),
      groupIds: String(group.id),
      name: "",
    });

    expect(response.status).toBe(400);
    expectIncludesAll(await response.text(), [
      `<a aria-current="page" class="active" href="/admin/listing/${listing.id}/edit">Edit</a>`,
      "Listing name is required",
      `checked name="groupIds" type="checkbox" value="${group.id}"`,
    ]);
  });
});
