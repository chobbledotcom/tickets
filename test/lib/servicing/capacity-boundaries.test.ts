/**
 * Servicing edge cases — capacity boundaries.
 *
 * The exact-boundary, tiling, zero-quantity, zero-cap, and cumulative cases
 * that the headline §2 tests approximate but don't pin. Each one exercises a
 * boundary the capacity guard's inequality (`<=` not `<`) and the half-open
 * range predicate (`[start, end)`) are the only defence for.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity.ts";
import {
  createDailyTestListing,
  createServicingHold,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectRejects,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing edge cases — capacity boundaries",
  { db: true },
  () => {
    test("a hold whose quantity equals the cap exactly fills it; one more is refused", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      await createServicingHold({
        date: "2026-07-01",
        listing: { maxAttendees: 5, name: "L" },
        quantity: 5,
      });
      expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
        0,
      );
      // A second hold of qty 1 against a cap of 5 (now full) is refused.
      await expectRejects(
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 5, name: "L" },
          quantity: 1,
        }),
      );
    });

    test("adjacent holds tile perfectly — the shared boundary day is not double-counted", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      // [07-01, 07-03) covers 07-01, 07-02. [07-03, 07-05) covers 07-03, 07-04.
      await createServicingHold({
        date: "2026-07-01",
        durationDays: 2,
        listing: { maxAttendees: 5, name: "L" },
        quantity: 3,
      });
      await createServicingHold({
        date: "2026-07-03",
        durationDays: 2,
        listing: { maxAttendees: 5, name: "L" },
        quantity: 3,
      });
      // 07-02 is only in the first hold (3 held); 07-03 only in the second.
      expect(await getListingRemainingForRange(listing.id, "2026-07-02")).toBe(
        2,
      );
      expect(await getListingRemainingForRange(listing.id, "2026-07-03")).toBe(
        2,
      );
      // No overlap: neither day shows 5 held (which would mean double-counting).
      expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
        2,
      );
      expect(await getListingRemainingForRange(listing.id, "2026-07-04")).toBe(
        2,
      );
    });

    test("two holds on the same day whose sum exceeds the cap: the second is refused (cumulative guard)", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      await createServicingHold({
        date: "2026-07-01",
        listing: { maxAttendees: 5, name: "L" },
        quantity: 3,
      });
      // 3 held, 2 remain; a second hold of 3 would total 6 > 5 — refused,
      // even though 3 alone would fit (3 <= 5). The guard is cumulative.
      await expectRejects(
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 5, name: "L" },
          quantity: 3,
        }),
      );
      // A hold of 2 (exactly the remainder) does fit.
      await createServicingHold({
        date: "2026-07-01",
        listing: { maxAttendees: 5, name: "L" },
        quantity: 2,
      });
      expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
        0,
      );
    });

    test("a hold with quantity 0 is rejected (a servicing hold must consume capacity)", async () => {
      // quantity=0 is the no-quantity sentinel concept for attendees; a
      // servicing hold with qty 0 would consume no capacity and be invisible
      // to tickets_count — it's not a hold at all.
      await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      await expectRejects(
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 5, name: "L" },
          quantity: 0,
        }),
      );
    });

    test("a listing with max_attendees = 0 refuses any hold (only overbook can land)", async () => {
      await createDailyTestListing({
        maxAttendees: 0,
        name: "Closed",
      });
      await expectRejects(
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 0, name: "Closed" },
          quantity: 1,
        }),
      );
      // allowOverbook bypasses the guard (operator closing a day entirely).
      const over = await createServicingHold({
        allowOverbook: true,
        date: "2026-07-01",
        listing: { maxAttendees: 0, name: "Closed" },
        quantity: 1,
      });
      expect(over.id).toBeGreaterThan(0);
    });

    test("group cap with mixed daily + standard listings: servicing on the daily counts correctly", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "mix",
        slug: "mix",
      });
      const daily = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "daily-in-group",
      });
      const standard = await createTestListing({
        maxAttendees: 10,
        name: "standard-in-group",
      });
      const { assignListingsToGroup } = await import("#shared/db/groups.ts");
      await assignListingsToGroup([standard.id], group.id);
      // Pre-book the standard listing with qty 2 (cumulative against group cap).
      const { createTestAttendeeDirect } = await import("#test-utils");
      await createTestAttendeeDirect(standard.id, "Real", "r@example.com", 2);
      // Servicing hold of qty 2 on the daily for 07-01: group cap (5) must
      // drop by both (2 real + 2 servicing) = 3 remain for that day.
      await createServicingHold({
        date: "2026-07-01",
        listing: {
          groupId: group.id,
          maxAttendees: 10,
          name: "daily-in-group",
        },
        quantity: 2,
      });
      const { getGroupRemainingForListing } = await import(
        "#shared/db/attendees/capacity.ts"
      );
      expect(await getGroupRemainingForListing(daily.id, "2026-07-01")).toBe(1);
    });
  },
);
