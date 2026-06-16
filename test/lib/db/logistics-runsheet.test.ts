import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  type DeliveryLegKind,
  getAgentRunSheet,
  setLegDone,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { logisticsAgentsTable } from "#shared/db/logistics-agents.ts";
import { createTestAttendee, createTestListing } from "#test-utils";
import { describeWithEnv } from "#test-utils/db.ts";

const D1 = "2026-06-16";
const D2 = "2026-06-17";
const D3 = "2026-06-18";

/** Create an attendee with one booking line, then stamp its logistics agents,
 * dates and done flags directly so the run-sheet query has known input. */
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
  const listing = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Cust",
    "c@example.com",
  );
  await setLogisticsAssignments(
    attendee.id,
    false,
    new Map([
      [
        listing.id,
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
      attendee.id,
      listing.id,
    ],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ?, start_done = ?, end_done = ? WHERE attendee_id = ? AND listing_id = ?",
  });
  return { attendeeId: attendee.id, listingId: listing.id };
};

describeWithEnv("db getAgentRunSheet", { db: true }, () => {
  let van: number;
  let other: number;
  beforeEach(async () => {
    van = (await logisticsAgentsTable.insert({ name: "Van" })).id;
    other = (await logisticsAgentsTable.insert({ name: "Other" })).id;
  });

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
    const { attendeeId, listingId } = await makeBooking({
      endAgentId: van,
      endDate: D2,
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
    await makeBooking({
      endAgentId: van,
      endDate: D3,
      startAgentId: van,
      startDate: D3,
    });
    expect(await getAgentRunSheet([van], [D1, D2])).toEqual([]);
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
});

describeWithEnv("db setLegDone", { db: true }, () => {
  let van: number;
  let other: number;
  beforeEach(async () => {
    van = (await logisticsAgentsTable.insert({ name: "Van" })).id;
    other = (await logisticsAgentsTable.insert({ name: "Other" })).id;
  });

  test("returns false for no agent ids", async () => {
    expect(await setLegDone(1, 1, "start", true, [])).toBe(false);
  });

  test("marks the start leg done for the owning agent", async () => {
    const { attendeeId, listingId } = await makeBooking({
      endAgentId: null,
      endDate: D2,
      startAgentId: van,
      startDate: D1,
    });
    const ok = await setLegDone(attendeeId, listingId, "start", true, [van]);
    expect(ok).toBe(true);
    const legs = await getAgentRunSheet([van], [D1]);
    expect(legs[0]?.done).toBe(true);
  });

  test("marks the end leg done independently of the start leg", async () => {
    const { attendeeId, listingId } = await makeBooking({
      endAgentId: van,
      endDate: D1,
      startAgentId: van,
      startDate: D1,
    });
    await setLegDone(attendeeId, listingId, "end", true, [van]);
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
    await setLegDone(attendeeId, listingId, "start", false, [van]);
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
    const ok = await setLegDone(attendeeId, listingId, kind, true, [van]);
    expect(ok).toBe(false);
    const legs = await getAgentRunSheet([other], [D1]);
    expect(legs[0]?.done).toBe(false);
  });
});
