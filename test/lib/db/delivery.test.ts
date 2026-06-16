import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  bookingAssignmentKey,
  clearDeliveryAgentReferences,
  getDeliveryAssignments,
  getDeliveryAssignmentsForAttendees,
  setDeliveryAssignments,
} from "#shared/db/delivery.ts";
import {
  deliveryAgentsTable,
  getAllDeliveryAgents,
  invalidateDeliveryAgentsCache,
} from "#shared/db/delivery-agents.ts";
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

describeWithEnv("db delivery agents", { db: true }, () => {
  test("bookingAssignmentKey joins attendee and listing ids", () => {
    expect(bookingAssignmentKey(3, 7)).toBe("3|7");
  });

  test("inserts and reads back delivery agents (decrypted)", async () => {
    await deliveryAgentsTable.insert({ name: "Van 1" });
    await deliveryAgentsTable.insert({ name: "Van 2" });
    const agents = await getAllDeliveryAgents();
    expect(agents.map((a) => a.name)).toEqual(["Van 1", "Van 2"]);
  });

  test("invalidateDeliveryAgentsCache forces a re-read", async () => {
    const agent = await deliveryAgentsTable.insert({ name: "Cached Van" });
    await getAllDeliveryAgents();
    await deliveryAgentsTable.deleteById(agent.id);
    invalidateDeliveryAgentsCache();
    const agents = await getAllDeliveryAgents();
    expect(agents.find((a) => a.id === agent.id)).toBeUndefined();
  });
});

describeWithEnv("db delivery assignments", { db: true }, () => {
  test("persists and reads per-listing assignments + split flag", async () => {
    const drop = await deliveryAgentsTable.insert({ name: "Drop" });
    const coll = await deliveryAgentsTable.insert({ name: "Coll" });
    const { attendeeId, listingId } = await newAttendee();

    await setDeliveryAssignments(
      attendeeId,
      true,
      new Map([
        [listingId, { collectionAgentId: coll.id, dropOffAgentId: drop.id }],
      ]),
    );

    const got = await getDeliveryAssignments(attendeeId);
    expect(got.get(listingId)).toEqual({
      collectionAgentId: coll.id,
      dropOffAgentId: drop.id,
    });
  });

  test("getDeliveryAssignmentsForAttendees returns [] for no ids", async () => {
    expect(await getDeliveryAssignmentsForAttendees([])).toEqual([]);
  });

  test("getDeliveryAssignmentsForAttendees returns one row per booking", async () => {
    const drop = await deliveryAgentsTable.insert({ name: "Drop" });
    const { attendeeId, listingId } = await newAttendee();
    await setDeliveryAssignments(
      attendeeId,
      false,
      new Map([
        [listingId, { collectionAgentId: null, dropOffAgentId: drop.id }],
      ]),
    );

    const rows = await getDeliveryAssignmentsForAttendees([attendeeId]);
    expect(rows).toEqual([
      {
        attendeeId,
        collectionAgentId: null,
        dropOffAgentId: drop.id,
        listingId,
      },
    ]);
  });

  test("clearDeliveryAgentReferences nulls both sides for an agent", async () => {
    const drop = await deliveryAgentsTable.insert({ name: "Drop" });
    const coll = await deliveryAgentsTable.insert({ name: "Coll" });
    const { attendeeId, listingId } = await newAttendee();
    await setDeliveryAssignments(
      attendeeId,
      false,
      new Map([
        [listingId, { collectionAgentId: coll.id, dropOffAgentId: drop.id }],
      ]),
    );

    await clearDeliveryAgentReferences(drop.id);

    const got = await getDeliveryAssignments(attendeeId);
    // Drop reference cleared, the (different) collection agent is untouched.
    expect(got.get(listingId)).toEqual({
      collectionAgentId: coll.id,
      dropOffAgentId: null,
    });
  });
});
