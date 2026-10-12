import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { N_PLUS_ONE_THRESHOLD } from "#db/query-log.ts";
import { loadOrderCatalog } from "#routes/public/order-catalog.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  enablePublicOrder,
  fetchAvailability,
  orderDate,
} from "#test/features/public/order/helpers.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";

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

      test("charges the sole child when the parent only books two days", async () => {
        // Both parents price one length: 2 days, and their sole child serves
        // exactly 2 days. The form folds the child at 2 days under the
        // selected parent, so its unit leaves the child pool and the rival
        // parent cannot join — the fold is charged, not filtered out at the
        // gallery's one-day span.
        const child = await createDailyTestListing({
          durationDays: 2,
          maxAttendees: 1,
          name: "Two Day Kit",
        });
        const parentA = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 2: 2000 },
          durationDays: 2,
          name: "Two Day Trip A",
        });
        const parentB = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 2: 2000 },
          durationDays: 2,
          name: "Two Day Trip B",
        });
        await listingChildren.setIds(parentA.id, [child.id]);
        await listingChildren.setIds(parentB.id, [child.id]);

        const data = await fetchAvailability(
          `select_${parentA.id}=1&start_date=${orderDate()}`,
        );
        expectState(data.states, parentA, { label: "", state: "selected" });
        expectState(data.states, parentB, {
          label: "Remove Two Day Trip A to add",
          state: "blocked",
        });
      });

      test("judges the folded child over the fixed parent's three days", async () => {
        // The fixed 3-day parent folds its sole customisable child at 3 days,
        // so the child's pool must cover every day of that span: a child full
        // on the second day reads unavailable, as the form refuses it.
        const child = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 2000, 3: 3000 },
          durationDays: 3,
          maxAttendees: 1,
          name: "Span Kit",
        });
        const parent = await createDailyTestListing({
          durationDays: 3,
          name: "Three Day Trip",
        });
        await listingChildren.setIds(parent.id, [child.id]);
        await bookAttendee(child, {
          date: addDays(orderDate(), 1),
          durationDays: 1,
        });

        const data = await fetchAvailability(`start_date=${orderDate()}`);
        expectState(data.states, parent, {
          label: "Sold Out",
          state: "unavailable",
        });
      });

      test("charges nothing when the fold does not hold at every offered span", async () => {
        // The customisable parent offers 1-3 days and its sole child serves
        // only one day: the fold resolves at the first span but not at the
        // later spans. The buyer's choice decides there, so no child quantity
        // is guaranteed and the gallery charges none — the rival parent
        // contending for the child pool stays available.
        const child = await createDailyTestListing({
          maxAttendees: 1,
          name: "One Day Kit",
        });
        const parent = await createDailyTestListing({
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 2000, 3: 3000 },
          durationDays: 3,
          name: "Any Length Trip",
        });
        await listingChildren.setIds(parent.id, [child.id]);
        const rival = await createTestListing({ name: "Rival Parent" });
        await listingChildren.setIds(rival.id, [child.id]);

        const data = await fetchAvailability(
          `select_${parent.id}=1&start_date=${orderDate()}`,
        );
        expectState(data.states, parent, { label: "", state: "selected" });
        expectState(data.states, rival, { label: "", state: "available" });
      });
    });

    describe("loadOrderCatalog", () => {
      enablePublicOrder();

      test("reads many parents' shared child once, not once per parent", async () => {
        // A capped group makes each per-parent child hydration read the
        // group's remaining again: one parent past the N+1 guard (25) would
        // cross it before the fold charges a single unit.
        const group = await createTestGroup({
          maxAttendees: 5,
          name: "Capped Pool",
        });
        const child = await createTestListing({
          groupId: group.id,
          maxAttendees: 5,
          name: "Pool Kit",
        });
        const parentIds: number[] = [];
        for (let i = 0; i <= N_PLUS_ONE_THRESHOLD; i++) {
          const parent = await createTestListing({
            name: `Catalog Parent ${i}`,
          });
          await listingChildren.setIds(parent.id, [child.id]);
          parentIds.push(parent.id);
        }

        const { value: catalog, roundTrips } = await runAndCountRoundTrips(() =>
          loadOrderCatalog(),
        );
        // One hydration covers every parent's children, so the catalog's
        // reads stay flat in the parent count (a per-parent read costs about
        // two each), and the fold still charges the shared child.
        const option = catalog.options.find(
          (o) => o.key === `listing:${parentIds[0]}`,
        );
        expect(option?.unitsByListingId.get(child.id)).toBe(1);
        expect(roundTrips).toBeLessThanOrEqual(20);
      });
    });
  },
);
