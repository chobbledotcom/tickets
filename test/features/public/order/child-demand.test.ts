import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  enablePublicOrder,
  fetchAvailability,
  orderDate,
} from "#test/features/public/order/helpers.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

/** Two parent listings that share one child listing with the given capacity. */
const sharedChildParents = async (childName: string, maxAttendees: number) => {
  const child = await createTestListing({ maxAttendees, name: childName });
  const parentA = await createTestListing({ name: `${childName} A` });
  const parentB = await createTestListing({ name: `${childName} B` });
  await listingChildren.setIds(parentA.id, [child.id]);
  await listingChildren.setIds(parentB.id, [child.id]);
  return { parentA, parentB };
};

/** Assert one option's live state on the availability endpoint. */
const expectState = (
  states: Record<string, { state: string; label: string }>,
  listing: { id: number },
  expected: { label: string; state: string },
): void => {
  expect(states[`listing:${listing.id}`]).toEqual(expected);
};

/**
 * The folded child demand the booking form guarantees: a parent whose only
 * bookable child is one listing auto-fills that child with the parent's whole
 * quantity (the form's own auto-fill). The gallery judges that demand, so two
 * selections contending for one child pool grey out here, as the form refuses
 * them.
 */
describeWithEnv(
  "server (public order) — auto-folded child demand",
  { db: true, triggers: true },
  () => {
    describe("GET /order/availability", () => {
      enablePublicOrder();

      test("blocks the second parent that contends for one shared child pool", async () => {
        // One child spot: one parent's auto-filled unit takes it, so the other
        // parent no longer fits beside the selection.
        const { parentA, parentB } = await sharedChildParents("Shared Kit", 1);

        const data = await fetchAvailability(`select_${parentA.id}=1`);
        expectState(data.states, parentA, { label: "", state: "selected" });
        expectState(data.states, parentB, {
          label: "Remove Shared Kit A to add",
          state: "blocked",
        });
      });

      test("keeps a parent available when the shared child has room", async () => {
        const { parentA, parentB } = await sharedChildParents("Roomy Kit", 5);

        const data = await fetchAvailability(`select_${parentA.id}=1`);
        expectState(data.states, parentA, { label: "", state: "selected" });
        // Two auto-filled units fit the child's five spots: no conflict.
        expectState(data.states, parentB, {
          label: "",
          state: "available",
        });
      });

      test("a child that is not the sole bookable one adds no demand", async () => {
        // Two bookable children: the form asks the buyer to choose, so no
        // child quantity is certain yet and the gallery must not charge one.
        // A wrong fold on Kit would take its only spot and block the rival.
        const kit = await createTestListing({
          maxAttendees: 1,
          name: "Chosen Kit",
        });
        const spare = await createTestListing({
          maxAttendees: 5,
          name: "Spare Kit",
        });
        const chooser = await createTestListing({ name: "Chooser" });
        await listingChildren.setIds(chooser.id, [kit.id, spare.id]);
        const rival = await createTestListing({ name: "Rival Parent" });
        await listingChildren.setIds(rival.id, [kit.id]);

        const data = await fetchAvailability(`select_${chooser.id}=1`);
        expectState(data.states, chooser, { label: "", state: "selected" });
        expectState(data.states, rival, {
          label: "",
          state: "available",
        });
      });

      test("a package charges the child its member parent auto-folds", async () => {
        // The bundle's member is a parent with one bookable child: the form
        // auto-fills the child with the member's quantity. One bundle takes
        // the child's only spot, so the rival parent cannot join it.
        const group = await createTestGroup({
          isPackage: true,
          name: "Camp Bundle",
          slug: "camp-bundle",
        });
        const member = await createTestListing({
          groupId: group.id,
          name: "Bundle Tent",
        });
        const child = await createTestListing({
          maxAttendees: 1,
          name: "Bundle Kit",
        });
        await listingChildren.setIds(member.id, [child.id]);
        const rival = await createTestListing({ name: "Rival Parent" });
        await listingChildren.setIds(rival.id, [child.id]);

        const data = await fetchAvailability(`select_package_${group.id}=1`);
        expect(data.states[`package:${group.id}`]).toEqual({
          label: "",
          state: "selected",
        });
        expectState(data.states, rival, {
          label: "Remove Camp Bundle to add",
          state: "blocked",
        });
      });

      test("a sole daily child that cannot serve the chosen date blocks its parent", async () => {
        // The fold is judged date-less, so the demand is charged, and the
        // child's per-date remaining reads zero on a date its calendar
        // refuses — the parent reads sold out for that date, as the form
        // refuses it there.
        const child = await createDailyTestListing({
          maximumDaysAfter: 14,
          name: "Near Day Child",
        });
        const parent = await createTestListing({ name: "Day Parent" });
        await listingChildren.setIds(parent.id, [child.id]);
        const farDate = addDays(testDate(todayInTz("UTC")), 30);

        // Date-less, the child has total room: the parent stays available.
        const dateless = await fetchAvailability("");
        expectState(dateless.states, parent, {
          label: "",
          state: "available",
        });

        // A date the child's calendar refuses zeroes the child's remaining,
        // so the auto-filled demand can never fit.
        const far = await fetchAvailability(`start_date=${farDate}`);
        expectState(far.states, parent, {
          label: "Sold Out",
          state: "unavailable",
        });

        // A date the child serves judges per-date capacity, not the calendar.
        const served = await fetchAvailability(`start_date=${orderDate()}`);
        expectState(served.states, parent, {
          label: "",
          state: "available",
        });
      });
    });
  },
);
