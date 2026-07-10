import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import {
  type DeliveryLegKind,
  getAgentRunSheet,
  getAgentRunSheetDates,
  type LogisticsAssignment,
  setLegDone,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingWithAttendeeAndLogistics } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const D1 = "2026-06-16";
const D2 = "2026-06-17";
const D3 = "2026-06-18";
const D4 = "2026-06-19";

/** Create an attendee with one booking line, then stamp its logistics agents,
 * dates and done flags directly so the run-sheet query has known input.
 *
 * `endDate` is stored verbatim as the exclusive `end_at`, so the collection
 * leg's run-sheet date is the day *before* it (the last booked day). */
const makeBooking = async (opts: {
  startAgentId: number | null;
  endAgentId: number | null;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  startDone?: boolean;
  endDone?: boolean;
}): Promise<{ attendeeId: number; listingId: number }> => {
  const { attendeeId, listingId } = await createListingWithAttendeeAndLogistics(
    (id) =>
      new Map([
        [
          id,
          {
            endAgentId: opts.endAgentId,
            endTime: opts.endTime ?? "",
            startAgentId: opts.startAgentId,
            startTime: opts.startTime ?? "",
          },
        ],
      ]),
  );
  await getDb().execute({
    args: [
      `${opts.startDate}T00:00:00Z`,
      `${opts.endDate}T00:00:00Z`,
      opts.startDone ? 1 : 0,
      opts.endDone ? 1 : 0,
      attendeeId,
      listingId,
    ],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ?, start_done = ?, end_done = ? WHERE attendee_id = ? AND listing_id = ?",
  });
  return { attendeeId, listingId };
};

const insertVanAndOther = async (): Promise<{
  van: number;
  other: number;
}> => ({
  other: (await logisticsAgents.table.insert({ name: "Other" })).id,
  van: (await logisticsAgents.table.insert({ name: "Van" })).id,
});

/** The one van pair every dual-path fixture stamps on its booking rows. */
const vanAssignment = (van: number): LogisticsAssignment => ({
  endAgentId: van,
  endTime: "17:00",
  startAgentId: van,
  startTime: "09:00",
});

/** Stamp an attendee's logistics (agents + the D1..D2 window) on every booking
 * row of a listing, exactly as the admin logistics form writes them. */
const stampLogistics = async (
  attendeeId: number,
  listingId: number,
  van: number,
): Promise<void> => {
  await setLogisticsAssignments(
    attendeeId,
    false,
    new Map([[listingId, vanAssignment(van)]]),
  );
  await getDb().execute({
    args: [`${D1}T00:00:00Z`, `${D2}T00:00:00Z`, attendeeId, listingId],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ? WHERE attendee_id = ? AND listing_id = ?",
  });
};

/** A dual-path booking — the listing booked through its package AND its own
 * standalone row in one order — with the same van/dates on both rows: the
 * shape a multi-package checkout stores. */
const makeDualPathBooking = async (
  van: number,
): Promise<{ attendeeId: number; listingId: number }> => {
  const group = await createTestGroup({ isPackage: true, name: "Run Kit" });
  const listing = await createTestListing({
    groupId: group.id,
    maxAttendees: 100,
    name: "Run Kit Tent",
  });
  await setGroupPackageMembers(group.id, [
    { listingId: listing.id, price: 500 },
  ]);
  const made = await createAttendeeAtomic({
    bookings: [
      { listingId: listing.id, packageGroupId: group.id, quantity: 2 },
      { listingId: listing.id, quantity: 1 },
    ],
    email: "run@example.com",
    name: "Dual Path",
  });
  const attendeeId = (made as Extract<typeof made, { success: true }>)
    .attendees[0]!.id;
  await stampLogistics(attendeeId, listing.id, van);
  return { attendeeId, listingId: listing.id };
};

describeWithEnv("db logistics run-sheet", { db: true }, () => {
  let van: number;
  let other: number;
  beforeEach(async () => {
    ({ van, other } = await insertVanAndOther());
  });

  describe("getAgentRunSheet", () => {
    test("returns [] for no agent ids", async () => {
      expect(await getAgentRunSheet([], [D1])).toEqual([]);
    });

    test("returns [] for no dates", async () => {
      expect(await getAgentRunSheet([van], [])).toEqual([]);
    });

    test("yields a drop-off leg for the start agent on a matching date", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: null,
        endDate: D3,
        startAgentId: van,
        startDate: D1,
        startTime: "09:00",
      });
      const legs = await getAgentRunSheet([van], [D1, D2]);
      expect(legs).toEqual([
        {
          agentId: van,
          attendeeId,
          date: D1,
          done: false,
          kind: "start",
          listingId,
          time: "09:00",
        },
      ]);
    });

    test("yields a collection leg for the end agent on a matching date", async () => {
      // end_at = D3 (exclusive), so the collection's run-sheet date is D2.
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: van,
        endDate: D3,
        endTime: "17:00",
        startAgentId: other,
        startDate: D1,
      });
      const legs = await getAgentRunSheet([van], [D1, D2]);
      expect(legs).toEqual([
        {
          agentId: van,
          attendeeId,
          date: D2,
          done: false,
          kind: "end",
          listingId,
          time: "17:00",
        },
      ]);
    });

    test("yields both legs when one agent does drop-off and collection", async () => {
      await makeBooking({
        endAgentId: van,
        endDate: D2,
        startAgentId: van,
        startDate: D1,
      });
      const legs = await getAgentRunSheet([van], [D1, D2]);
      expect(legs.map((l) => l.kind).sort()).toEqual(["end", "start"]);
    });

    test("excludes legs whose date is outside the window", async () => {
      // Drop-off on D3 and collection on D3 (end_at = D4), both past [D1, D2].
      await makeBooking({
        endAgentId: van,
        endDate: D4,
        startAgentId: van,
        startDate: D3,
      });
      expect(await getAgentRunSheet([van], [D1, D2])).toEqual([]);
    });

    test("issues no query at all when the agent set is empty", async () => {
      // The empty-input early return is a subrequest-budget contract: an empty
      // agent set must answer [] without ever hitting the database.
      const { entries, legs } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const legs = await getAgentRunSheet([], [D1]);
        return { entries: getQueryLog(), legs };
      });
      expect(legs).toEqual([]);
      expect(entries).toHaveLength(0);
    });

    test("excludes a collection leg outside the window even when its drop-off matches", async () => {
      // The row matches the query via its drop-off (D1), but the collection
      // falls on D3 (end_at = D4, exclusive) — outside the requested [D1]
      // window — so only the drop-off leg may appear on the run sheet.
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: van,
        endDate: D4,
        startAgentId: van,
        startDate: D1,
      });
      const legs = await getAgentRunSheet([van], [D1]);
      expect(legs).toEqual([
        {
          agentId: van,
          attendeeId,
          date: D1,
          done: false,
          kind: "start",
          listingId,
          time: "",
        },
      ]);
    });

    test("bookings whose ids run together never collapse into one leg", async () => {
      // Attendee 91 on listing 12345 and attendee 911 on listing 2345: their
      // identity fields concatenate to the same digits ("9112345…"), so only
      // the "|" separator in the collapse key keeps these two different
      // deliveries apart. Same agent, date and time on both rows.
      for (const [attendeeId, listingId] of [
        [91, 12345],
        [911, 2345],
      ]) {
        await getDb().execute({
          args: [
            listingId!,
            attendeeId!,
            van,
            `${D1}T00:00:00Z`,
            `${D2}T00:00:00Z`,
          ],
          sql: `INSERT INTO listing_attendees
                  (listing_id, attendee_id, quantity, start_agent_id, start_time, start_done, start_at, end_at)
                VALUES (?, ?, 1, ?, '', 0, ?, ?)`,
        });
      }
      const legs = await getAgentRunSheet([van], [D1]);
      expect(
        legs
          .filter((leg) => leg.kind === "start")
          .map((leg) => [leg.attendeeId, leg.listingId])
          .sort((a, b) => a[0]! - b[0]!),
      ).toEqual([
        [91, 12345],
        [911, 2345],
      ]);
    });

    test("excludes legs for agents not in the set", async () => {
      await makeBooking({
        endAgentId: other,
        endDate: D2,
        startAgentId: other,
        startDate: D1,
      });
      expect(await getAgentRunSheet([van], [D1, D2])).toEqual([]);
    });

    test("ignores a collection leg when the booking has no end date", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: van,
        endDate: D1,
        startAgentId: van,
        startDate: D1,
      });
      // Null out end_at so the collection leg's date is null even though its
      // agent is in the set.
      await getDb().execute({
        args: [attendeeId, listingId],
        sql: "UPDATE listing_attendees SET end_at = NULL WHERE attendee_id = ? AND listing_id = ?",
      });
      const legs = await getAgentRunSheet([van], [D1]);
      expect(legs.map((l) => l.kind)).toEqual(["start"]);
    });

    test("reflects the done flags", async () => {
      await makeBooking({
        endAgentId: van,
        endDate: D2,
        endDone: false,
        startAgentId: van,
        startDate: D1,
        startDone: true,
      });
      const legs = await getAgentRunSheet([van], [D1, D2]);
      const start = legs.find((l) => l.kind === "start");
      const end = legs.find((l) => l.kind === "end");
      expect(start?.done).toBe(true);
      expect(end?.done).toBe(false);
    });

    test("a dual-path booking is ONE drop-off and ONE collection, not one per row", async () => {
      const { attendeeId, listingId } = await makeDualPathBooking(van);
      // A second attendee's delivery on the same listing/van/window stays its
      // own legs — only the SAME booking's path rows collapse.
      const made = await createAttendeeAtomic({
        bookings: [{ listingId, quantity: 1 }],
        email: "solo@example.com",
        name: "Solo",
      });
      const soloId = (made as Extract<typeof made, { success: true }>)
        .attendees[0]!.id;
      await stampLogistics(soloId, listingId, van);

      const legs = await getAgentRunSheet([van], [D1]);
      // end_at = D2 (exclusive) puts both collections on D1 too.
      expect(legs.map((leg) => [leg.attendeeId, leg.kind]).sort()).toEqual(
        [
          [attendeeId, "start"],
          [attendeeId, "end"],
          [soloId, "start"],
          [soloId, "end"],
        ].sort(),
      );
    });

    test("a collapsed leg is done only when EVERY path row is done", async () => {
      const { attendeeId, listingId } = await makeDualPathBooking(van);
      // One path ticked (say a stray direct write): the delivery is still
      // outstanding, whichever order the rows arrive in.
      await getDb().execute({
        args: [attendeeId, listingId],
        sql: `UPDATE listing_attendees SET start_done = 1
              WHERE attendee_id = ? AND listing_id = ? AND package_group_id > 0`,
      });
      const before = await getAgentRunSheet([van], [D1]);
      expect(before.find((l) => l.kind === "start")?.done).toBe(false);

      // Ticking the run-sheet leg completes every path row together.
      await setLegDone(attendeeId, listingId, "start", D1, true, [van]);
      const after = await getAgentRunSheet([van], [D1]);
      expect(after.find((l) => l.kind === "start")?.done).toBe(true);
      const rows = await queryAll<{ start_done: number }>(
        "SELECT start_done FROM listing_attendees WHERE attendee_id = ?",
        [attendeeId],
      );
      expect(rows.map((row) => row.start_done)).toEqual([1, 1]);
    });
  });

  describe("getAgentRunSheetDates", () => {
    test("returns [] for no agent ids without hitting the database", async () => {
      const { entries, dates } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const dates = await getAgentRunSheetDates([]);
        return { dates, entries: getQueryLog() };
      });
      expect(dates).toEqual([]);
      expect(entries).toHaveLength(0);
    });

    test("returns the drop-off and collection dates, sorted and deduped", async () => {
      // Drop-off D1, collection on D2 (end_at = D3, exclusive → last booked day).
      await makeBooking({
        endAgentId: van,
        endDate: D3,
        startAgentId: van,
        startDate: D1,
      });
      // A second booking dropped off the same day the first is collected, so D2
      // is offered by both — it must appear only once.
      await makeBooking({
        endAgentId: van,
        endDate: D4,
        startAgentId: van,
        startDate: D2,
      });
      expect(await getAgentRunSheetDates([van])).toEqual([D1, D2, D3]);
    });

    test("excludes dates for agents outside the set", async () => {
      await makeBooking({
        endAgentId: other,
        endDate: D2,
        startAgentId: other,
        startDate: D1,
      });
      expect(await getAgentRunSheetDates([van])).toEqual([]);
    });

    test("ignores no-quantity sentinel lines", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: van,
        endDate: D2,
        startAgentId: van,
        startDate: D1,
      });
      await getDb().execute({
        args: [attendeeId, listingId],
        sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
      });
      expect(await getAgentRunSheetDates([van])).toEqual([]);
    });
  });

  describe("setLegDone", () => {
    test("returns false for no agent ids", async () => {
      expect(await setLegDone(1, 1, "start", D1, true, [])).toBe(false);
    });

    test("marks the start leg done for the owning agent", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: null,
        endDate: D2,
        startAgentId: van,
        startDate: D1,
      });
      const ok = await setLegDone(attendeeId, listingId, "start", D1, true, [
        van,
      ]);
      expect(ok).toBe(true);
      const legs = await getAgentRunSheet([van], [D1]);
      expect(legs[0]?.done).toBe(true);
    });

    test("marks the end leg done independently of the start leg", async () => {
      // end_at = D2 so the collection's run-sheet date is D1, same as drop-off.
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: van,
        endDate: D2,
        startAgentId: van,
        startDate: D1,
      });
      await setLegDone(attendeeId, listingId, "end", D1, true, [van]);
      const legs = await getAgentRunSheet([van], [D1]);
      expect(legs.find((l) => l.kind === "start")?.done).toBe(false);
      expect(legs.find((l) => l.kind === "end")?.done).toBe(true);
    });

    test("can unmark a leg", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: null,
        endDate: D2,
        startAgentId: van,
        startDate: D1,
        startDone: true,
      });
      await setLegDone(attendeeId, listingId, "start", D1, false, [van]);
      const legs = await getAgentRunSheet([van], [D1]);
      expect(legs[0]?.done).toBe(false);
    });

    test("refuses to update a leg owned by another agent", async () => {
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: null,
        endDate: D2,
        startAgentId: other,
        startDate: D1,
      });
      const kind: DeliveryLegKind = "start";
      const ok = await setLegDone(attendeeId, listingId, kind, D1, true, [van]);
      expect(ok).toBe(false);
      const legs = await getAgentRunSheet([other], [D1]);
      expect(legs[0]?.done).toBe(false);
    });

    test("refuses to update an owning agent leg on a different date", async () => {
      // The leg is genuinely the van's, but on D3 — marking it via a D1 form
      // must not flip a leg on a day the run sheet wasn't showing.
      const { attendeeId, listingId } = await makeBooking({
        endAgentId: null,
        endDate: D4,
        startAgentId: van,
        startDate: D3,
      });
      const ok = await setLegDone(attendeeId, listingId, "start", D1, true, [
        van,
      ]);
      expect(ok).toBe(false);
      const legs = await getAgentRunSheet([van], [D3]);
      expect(legs[0]?.done).toBe(false);
    });
  });
});
