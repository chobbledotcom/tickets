/** The edit save path directly: the role rule over submitted aggregates. The
 * route wiring has its own suite; this pins the role decision itself. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { recomputeListingBookingRanges } from "#db/attendees/update.ts";
import { executeUpdate } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import {
  earliestGroupCapOverflow,
  parseAggregatesForRole,
} from "#routes/admin/listings-edit-save.ts";
import { formDataToParams } from "#routes/csrf.ts";
import type { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import type { AdminSession } from "#types";

const sessionOf = (adminLevel: "owner" | "editor"): AdminSession =>
  ({ adminLevel }) as AdminSession;

/** An edit form's counters: both trigger-maintained fields always submit. */
const formWithAggregates = (
  bookedQuantity: string,
  ticketsCount: string,
): FormParams => {
  const body = new FormData();
  body.set("booked_quantity", bookedQuantity);
  body.set("tickets_count", ticketsCount);
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
      expect(result.input).toEqual({ booked_quantity: 12, tickets_count: 13 });
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
    await executeUpdate(
      "groups",
      { max_attendees: 10 },
      {
        id: dayLaterOverflow.id,
      },
    );
    await executeUpdate(
      "groups",
      { max_attendees: 10 },
      {
        id: dayEarlierOverflow.id,
      },
    );

    expect(await earliestGroupCapOverflow(target.id)).toBe(DAY_1);
  });
});
