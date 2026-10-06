/** Day-span projection for parent/child discovery: a parent's offered span and
 *  its child's bookable dates must line up, or the parent reads sold out. The
 *  capacity-side suites live in discovery.test.ts; these tests own the daily
 *  span, weekday, and static-cap cases. */

import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeParent } from "#test-utils/parents.ts";
import {
  assertBookable,
  assertSoldOut,
  makeThreeDayParent,
} from "./discovery-helpers.ts";

describeWithEnv(
  "listing parent discovery — day spans",
  { db: true, triggers: true },
  () => {
    describe("public listing cards (/listings)", () => {
      test("a daily parent + daily child sharing a 1-cap group is sold out date-less (static cap)", async () => {
        // A daily child's per-date group-remaining is unknown without a
        // submitted date, so the dynamic combined-demand check cannot see the
        // shortage. But a group whose STATIC cap is below the parent+child
        // minimum (two spots) can NEVER hold the pair on any date, so discovery
        // must read the parent sold out from the static cap alone — otherwise it
        // advertises a booking the submit fold always rejects.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Daily add-on" }],
          group: { maxAttendees: 1, name: "Tiny pool" },
          parent: { daily: true, name: "Base unit" },
        });
        await assertSoldOut(parent.slug);
      });

      test("a daily parent + daily child sharing a 2-cap group stays bookable date-less", async () => {
        // Static cap 2 meets the parent+child minimum; a daily child's per-date
        // remaining is deferred to the submit fold — so discovery keeps the Book
        // link rather than over-suppressing on a group that can hold the pair.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Daily add-on" }],
          group: { maxAttendees: 2, name: "Pool" },
          parent: { daily: true, name: "Base unit" },
        });
        await assertBookable(parent.slug);
      });

      test("a customisable parent offering only a 2-day span is sold out when its child serves no 2-day run", async () => {
        // The parent is CUSTOMISABLE but only prices a 2-day booking, so it has
        // NO one-day option. Its only child is a daily add-on bookable on
        // Mondays alone — it has a one-day Monday start but no Mon–Tue run. A
        // one-day fallback would advertise the parent; discovery must test the
        // child against the parent's REAL offered span (2), so it reads sold out.
        const { parent } = await makeParent({
          children: [
            { bookableDays: ["Monday"], daily: true, name: "Monday add-on" },
          ],
          parent: {
            customisableDays: true,
            daily: true,
            dayPrices: { 2: 2000 },
            durationDays: 2,
            name: "2-day customisable base",
          },
        });
        await assertSoldOut(parent.slug);
      });

      test("a customisable parent offering only a 2-day span stays bookable when its child serves a 2-day run", async () => {
        // Same 2-day-only customisable parent, but the child is bookable every
        // day, so a Mon–Tue 2-day run is valid — the parent keeps its Book link.
        const { parent } = await makeParent({
          children: [{ daily: true, name: "Any-day add-on" }],
          parent: {
            customisableDays: true,
            daily: true,
            dayPrices: { 2: 2000 },
            durationDays: 2,
            name: "2-day customisable base",
          },
        });
        await assertBookable(parent.slug);
      });

      test("a fixed multi-day daily parent whose only child can't fit the span is sold out", async () => {
        // The parent is a FIXED 3-day daily listing, so its children inherit a
        // 3-day span at the till. Its only child is a customisable daily add-on
        // that can be booked single days but never a 3-consecutive-day run (only
        // Mondays are bookable, so Mon–Wed always hits an unbookable Tue/Wed). A
        // span-blind discovery check (any one-day start exists) would advertise
        // the parent, but the gate's date union span-constrains it to empty and
        // the submit rejects — so it must read sold out.
        const { parent } = await makeThreeDayParent(["Monday"]);
        await assertSoldOut(parent.slug);
      });

      test("a fixed multi-day daily parent whose child can fit the span is advertised", async () => {
        // Same fixed 3-day parent, but the child can be booked any weekday, so a
        // Mon–Wed 3-day run is valid — the parent keeps its Book link.
        const { parent } = await makeThreeDayParent();
        await assertBookable(parent.slug);
      });

      test("a daily parent whose only child has disjoint bookable weekdays is sold out", async () => {
        // Both are single-day daily listings, but the parent is bookable only on
        // Mondays and its only child only on Tuesdays. The child has a bookable
        // start on its own calendar (Tuesday), so a child-calendar-only check
        // would still advertise the parent — yet there is NO date the parent can
        // offer on which the child is bookable, so `getTicketContext`'s date union
        // renders empty and the parent must read sold out.
        const { parent } = await makeParent({
          children: [
            {
              bookableDays: ["Tuesday"],
              daily: true,
              name: "Tuesday add-on",
            },
          ],
          parent: {
            bookableDays: ["Monday"],
            daily: true,
            name: "Monday base",
          },
        });
        await assertSoldOut(parent.slug);
      });

      test("a daily parent whose child shares a bookable weekday stays advertised", async () => {
        // The child is bookable on a weekday the parent also offers (Monday), so
        // there is an overlapping date the gate can serve — the parent keeps its
        // Book link (the overlap is satisfied, not over-eager).
        const { parent } = await makeParent({
          children: [
            {
              bookableDays: ["Monday", "Tuesday"],
              daily: true,
              name: "Mon/Tue add-on",
            },
          ],
          parent: {
            bookableDays: ["Monday"],
            daily: true,
            name: "Monday base",
          },
        });
        await assertBookable(parent.slug);
      });
    });
  },
);
