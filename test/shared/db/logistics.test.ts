import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#shared/db/client.ts";
import {
  bookingAssignmentKey,
  clearLogisticsAgentReferences,
  getAgentRunSheetBookings,
  getLogisticsAssignments,
  getLogisticsAssignmentsForAttendees,
  runSheetBookingKey,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  assignBookingLogistics,
  insertSecondBookingRow,
  logisticsAgentAssignment,
} from "#test-utils/logistics.ts";

const D1 = "2026-06-16";
const D2 = "2026-06-17";
const D3 = "2026-06-18";

const newAttendee = async (): Promise<{
  attendeeId: number;
  listingId: number;
}> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Cust",
    "c@example.com",
  );
  return { attendeeId: attendee.id, listingId: listing.id };
};

const setupDropoffAndCollection = async (split: boolean) => {
  const drop = await logisticsAgents.table.insert({ name: "Drop" });
  const coll = await logisticsAgents.table.insert({ name: "Coll" });
  const { attendeeId, listingId } = await newAttendee();
  const assignment = {
    endAgentId: coll.id,
    endTime: "17:00",
    startAgentId: drop.id,
    startTime: "09:00",
  };
  await setLogisticsAssignments(
    attendeeId,
    split,
    new Map([[listingId, assignment]]),
  );
  return { assignment, attendeeId, coll, drop, listingId };
};

describeWithEnv("db logistics agents", { db: true }, () => {
  test("bookingAssignmentKey joins attendee and listing ids", () => {
    expect(bookingAssignmentKey(3, 7)).toBe("3|7");
  });

  test("inserts and reads back logistics agents (decrypted)", async () => {
    await logisticsAgents.table.insert({ name: "Van 1" });
    await logisticsAgents.table.insert({ name: "Van 2" });
    const agents = await logisticsAgents.getAll();
    expect(agents.map((a) => a.name)).toEqual(["Van 1", "Van 2"]);
  });

  test("invalidateLogisticsAgentsCache forces a re-read", async () => {
    const agent = await logisticsAgents.table.insert({ name: "Cached Van" });
    await logisticsAgents.getAll();
    await logisticsAgents.table.deleteById(agent.id);
    logisticsAgents.invalidate();
    const agents = await logisticsAgents.getAll();
    expect(agents.find((a) => a.id === agent.id)).toBeUndefined();
  });
});

describeWithEnv("db logistics assignments", { db: true }, () => {
  test("persists and reads per-listing agents + times + split flag", async () => {
    const { assignment, attendeeId, listingId } =
      await setupDropoffAndCollection(true);

    const got = await getLogisticsAssignments(attendeeId);
    expect(got.get(listingId)).toEqual(assignment);
  });

  test("persists the split flag on the attendees row", async () => {
    const { attendeeId } = await setupDropoffAndCollection(true);
    const readFlag = async (): Promise<number> =>
      (
        await queryAll<{ split_logistics_agents: number }>(
          "SELECT split_logistics_agents FROM attendees WHERE id = ?",
          [attendeeId],
        )
      )[0]!.split_logistics_agents;
    expect(await readFlag()).toBe(1);

    // Re-saving with split off (and no per-listing rows) flips the flag back.
    await setLogisticsAssignments(attendeeId, false, new Map());
    expect(await readFlag()).toBe(0);
  });

  test("getLogisticsAssignmentsForAttendees returns [] for no ids", async () => {
    expect(await getLogisticsAssignmentsForAttendees([])).toEqual([]);
  });

  test("getLogisticsAssignmentsForAttendees returns one row per booking", async () => {
    const drop = await logisticsAgents.table.insert({ name: "Drop" });
    const { attendeeId, listingId } = await newAttendee();
    await setLogisticsAssignments(
      attendeeId,
      false,
      new Map([
        [
          listingId,
          {
            endAgentId: null,
            endTime: "",
            startAgentId: drop.id,
            startTime: "",
          },
        ],
      ]),
    );

    const rows = await getLogisticsAssignmentsForAttendees([attendeeId]);
    expect(rows).toEqual([
      {
        attendeeId,
        endAgentId: null,
        endTime: "",
        listingId,
        startAgentId: drop.id,
        startTime: "",
      },
    ]);
  });

  test("getAgentRunSheetBookings returns empty for missing inputs", async () => {
    const booking = { attendeeId: 1, listingId: 1 };
    expect(await getAgentRunSheetBookings([], [D1], [booking])).toEqual([]);
    expect(await getAgentRunSheetBookings([1], [], [booking])).toEqual([]);
    expect(await getAgentRunSheetBookings([1], [D1], [])).toEqual([]);
  });

  test("getAgentRunSheetBookings keeps only requested bookings on the agent's run sheet", async () => {
    const van = (await logisticsAgents.table.insert({ name: "Van" })).id;
    const other = (await logisticsAgents.table.insert({ name: "Other" })).id;
    const mine = await newAttendee();
    const theirs = await newAttendee();

    await assignBookingLogistics(mine, logisticsAgentAssignment(van), D1, D2);
    await assignBookingLogistics(
      theirs,
      logisticsAgentAssignment(other),
      D1,
      D2,
    );

    const bookings = await getAgentRunSheetBookings(
      [van],
      [D1],
      [mine, theirs],
    );
    expect(bookings).toEqual([
      {
        attendeeId: mine.attendeeId,
        date: D1,
        listingId: mine.listingId,
        packageGroupId: 0,
        parentListingId: 0,
      },
    ]);
  });

  test("getAgentRunSheetBookings uses the run sheet collection date", async () => {
    const van = (await logisticsAgents.table.insert({ name: "Van" })).id;
    const booking = await newAttendee();
    await assignBookingLogistics(
      booking,
      {
        ...logisticsAgentAssignment(van),
        startAgentId: null,
      },
      D1,
      D3,
    );

    const bookings = await getAgentRunSheetBookings([van], [D2], [booking]);
    expect(bookings).toEqual([
      {
        attendeeId: booking.attendeeId,
        // The collection leg's date is `end_at - 1 day` (D3 − 1 = D2).
        date: D1,
        listingId: booking.listingId,
        packageGroupId: 0,
        parentListingId: 0,
      },
    ]);
  });

  test("getAgentRunSheetBookings excludes no-quantity bookings", async () => {
    const van = (await logisticsAgents.table.insert({ name: "Van" })).id;
    const booking = await newAttendee();
    await assignBookingLogistics(
      booking,
      logisticsAgentAssignment(van),
      D1,
      D2,
    );
    await getDb().execute({
      args: [booking.attendeeId, booking.listingId],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
    });

    expect(await getAgentRunSheetBookings([van], [D1], [booking])).toEqual([]);
  });

  test("getAgentRunSheetBookings keeps only the matched row when one attendee has two rows on the same listing on different dates", async () => {
    // The row identity is `(listing_id, attendee_id, start_at,
    // parent_listing_id, package_group_id)`. Two rows for one attendee on the
    // same listing must differ on `start_at`, so an agent who owns only the
    // first row's leg must NOT see the second row's date/quantity. This is the
    // multi-row regression Codex's review on PR #1995 called out: returning
    // the (attendee, listing) pair alone would let one assigned row bless a
    // sibling row outside the agent's run sheet.
    const van = (await logisticsAgents.table.insert({ name: "Van" })).id;
    const { attendeeId, listingId } = await newAttendee();
    // Row A: today, owned by `van`. owner_start_agent means drop-off today.
    await assignBookingLogistics(
      { attendeeId, listingId },
      logisticsAgentAssignment(van),
      D1,
      D2,
    );
    // Row B: a different date, no logistics agents — never on `van`'s run sheet.
    await insertSecondBookingRow(attendeeId, listingId, D3);

    const bookings = await getAgentRunSheetBookings(
      [van],
      [D1],
      [{ attendeeId, listingId }],
    );
    // Only Row A's slot identity comes back; Row B (D3, no agent) is filtered.
    expect(bookings).toEqual([
      {
        attendeeId,
        date: D1,
        listingId,
        packageGroupId: 0,
        parentListingId: 0,
      },
    ]);

    // The filter side: a token entry on Row B's slot identity must NOT match
    // the row keys built from Row A's identity. Two entries with the same
    // (attendee, listing) but different `date` produce different keys.
    const rowAKey = runSheetBookingKey({
      attendeeId,
      date: D1,
      listingId,
      packageGroupId: 0,
      parentListingId: 0,
    });
    const rowBKey = runSheetBookingKey({
      attendeeId,
      date: D3,
      listingId,
      packageGroupId: 0,
      parentListingId: 0,
    });
    expect(rowAKey).not.toBe(rowBKey);
    expect(new Set(bookings.map(runSheetBookingKey)).has(rowAKey)).toBe(true);
    expect(new Set(bookings.map(runSheetBookingKey)).has(rowBKey)).toBe(false);
  });

  test("clearLogisticsAgentReferences nulls agents but keeps times", async () => {
    const { assignment, attendeeId, drop, listingId } =
      await setupDropoffAndCollection(false);

    await clearLogisticsAgentReferences(drop.id);

    const got = await getLogisticsAssignments(attendeeId);
    // Drop reference cleared, the (different) end agent and times are untouched.
    expect(got.get(listingId)).toEqual({ ...assignment, startAgentId: null });
  });

  test("clearLogisticsAgentReferences nulls end references for that agent only", async () => {
    const first = await setupDropoffAndCollection(false);
    const second = await setupDropoffAndCollection(false); // its own agent pair

    await clearLogisticsAgentReferences(first.coll.id);

    // The end reference is cleared; the start agent and times survive.
    const got = await getLogisticsAssignments(first.attendeeId);
    expect(got.get(first.listingId)).toEqual({
      ...first.assignment,
      endAgentId: null,
    });
    // Another booking's references to DIFFERENT agents are untouched.
    const other = await getLogisticsAssignments(second.attendeeId);
    expect(other.get(second.listingId)).toEqual(second.assignment);
  });
});
