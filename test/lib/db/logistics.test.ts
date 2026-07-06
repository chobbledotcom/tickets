import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  bookingAssignmentKey,
  clearLogisticsAgentReferences,
  getLogisticsAssignments,
  getLogisticsAssignmentsForAttendees,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { queryAll } from "#shared/db/client.ts";
import {
  getAllLogisticsAgents,
  invalidateLogisticsAgentsCache,
  logisticsAgentsTable,
} from "#shared/db/logistics-agents.ts";
import { createTestAttendee, createTestListing } from "#test-utils";
import { describeWithEnv } from "#test-utils/db.ts";

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
  const drop = await logisticsAgentsTable.insert({ name: "Drop" });
  const coll = await logisticsAgentsTable.insert({ name: "Coll" });
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
    await logisticsAgentsTable.insert({ name: "Van 1" });
    await logisticsAgentsTable.insert({ name: "Van 2" });
    const agents = await getAllLogisticsAgents();
    expect(agents.map((a) => a.name)).toEqual(["Van 1", "Van 2"]);
  });

  test("invalidateLogisticsAgentsCache forces a re-read", async () => {
    const agent = await logisticsAgentsTable.insert({ name: "Cached Van" });
    await getAllLogisticsAgents();
    await logisticsAgentsTable.deleteById(agent.id);
    invalidateLogisticsAgentsCache();
    const agents = await getAllLogisticsAgents();
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
      (await queryAll<{ split_logistics_agents: number }>(
        "SELECT split_logistics_agents FROM attendees WHERE id = ?",
        [attendeeId],
      ))[0]!.split_logistics_agents;
    expect(await readFlag()).toBe(1);

    // Re-saving with split off (and no per-listing rows) flips the flag back.
    await setLogisticsAssignments(attendeeId, false, new Map());
    expect(await readFlag()).toBe(0);
  });

  test("getLogisticsAssignmentsForAttendees returns [] for no ids", async () => {
    expect(await getLogisticsAssignmentsForAttendees([])).toEqual([]);
  });

  test("getLogisticsAssignmentsForAttendees returns one row per booking", async () => {
    const drop = await logisticsAgentsTable.insert({ name: "Drop" });
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
