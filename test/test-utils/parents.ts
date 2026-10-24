/**
 * Shared test helpers for the parent/child listings feature.
 *
 * The same imperative scenario setup (`createTestListing` ×N + `setChildIds`)
 * was repeated hundreds of times across the `server-parents-*` and
 * `server-listing-parents` suites; it lives here once. The HTTP request and
 * assertion helpers for the booking side live in `parent-booking.ts`.
 *
 * {@link makeParent} is the declarative scenario builder: describe a parent, its
 * children, and (optionally) a shared capped group, and get back the created
 * rows with the parent→child edges already wired — so a test states the
 * relationship it needs instead of assembling it line by line.
 */

import { assert } from "@std/assert";
import { listingChildren } from "#db/listing-parents.ts";
import type { Group, ListingWithCount } from "#types";
import { testPageHtml } from "#test-utils/mocks.ts";
import { createTestAttendee } from "./db-helpers/attendees.ts";
import { createTestGroup } from "./db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "./db-helpers/listings.ts";
import { enablePublicSite } from "./settings.ts";

/** A parent sharing a roomy 10-spot "Shared" group with its only child, and the
 *  child ALSO in a tighter 1-spot "Tighter" group of its own — the shared setup
 *  behind the "child not sold out by its tighter non-shared group" render and
 *  discovery tests. The combined-demand check must use the group the parent and
 *  child SHARE (10), not the child's tightest group overall (1). */
export const makeRoomySharedChild = async (): Promise<{
  child: ListingWithCount;
  parent: ListingWithCount;
}> => {
  const groupA = await createTestGroup({ maxAttendees: 10, name: "Shared" });
  const groupB = await createTestGroup({ maxAttendees: 1, name: "Tighter" });
  const parent = await createTestListing({
    groupIds: [groupA.id],
    maxAttendees: 100,
    name: "Base unit",
  });
  const child = await createTestListing({
    groupIds: [groupA.id, groupB.id],
    maxAttendees: 100,
    name: "Add-on",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

/** A parent with TWO default children, returning `childA`/`childB` for the
 * per-unit multi-child fold tests so each can name its chosen child without
 * re-declaring the `makeParent({ children: [{}, {}] })` + destructure pair.
 * `parentSpec` overrides the parent's own spec (e.g. `{ maxQuantity: 5 }`). */
export const makeTwoDefaultChildren = async (
  parentSpec?: ListingSpec,
): Promise<{
  childA: ListingWithCount;
  childB: ListingWithCount;
  parent: ListingWithCount;
}> => {
  const { parent, children } = await makeParent({
    children: [{}, {}],
    ...(parentSpec !== undefined ? { parent: parentSpec } : {}),
  });
  return { childA: children[0]!, childB: children[1]!, parent };
};

/** A fixed 3-day daily parent with a customisable child priced 1 day £10 / 3
 *  days £30 (unit_price 0) — the shared spec behind the "child inherits the
 *  parent's duration" tests in both the parents-gate and parents-booking
 *  suites. Declared once so the spec can't drift across the two. */
export const makeCustomisableDailyParent = () =>
  makeParent({
    children: [
      {
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        maxPrice: 0,
        unitPrice: 0,
      },
    ],
    parent: { daily: true, durationDays: 3 },
  });

/** Build a parent with two children and deactivate the second: the shared
 * "inactive child has spare capacity but the booking fold rejects it"
 * scenario. Returns the parent, the active child, and the deactivated child
 * so detail/availability assertions can name the bookable side. */
export const makeParentWithDeactivatedChild = async (): Promise<{
  inactiveChild: ListingWithCount;
  okChild: ListingWithCount;
  parent: ListingWithCount;
}> => {
  const { parent, children } = await makeParent({ children: [{}, {}] });
  const okChild = children[0]!;
  const inactiveChild = children[1]!;
  const { execute } = await import("#db/client.ts");
  await execute("UPDATE listings SET active = 0 WHERE id = ?", [
    inactiveChild.id,
  ]);
  return { inactiveChild, okChild, parent };
};

/** One listing in a {@link makeParent} spec: the usual `createTestListing`
 * overrides, plus `daily: true` to create it through `createDailyTestListing`. */
type ListingSpec = Parameters<typeof createTestListing>[0] & {
  daily?: boolean;
};

const makeListing = (
  spec: ListingSpec = {},
  fallbackName: string,
): Promise<ListingWithCount> => {
  const { daily, ...overrides } = spec;
  const input = { name: fallbackName, ...overrides };
  return daily ? createDailyTestListing(input) : createTestListing(input);
};

/**
 * Create a parent listing, its required children, and the parent→child edges in
 * one declarative call. A parent defaults to an empty thank-you URL (so a
 * completed booking lands on the public reservation page, which most gate tests
 * assert) and `children` defaults to a single child.
 *
 * `group`, when given, creates one capped group shared by the parent AND every
 * child (the common "parent + child contend for the same pool" shape, invariant
 * I7); a child spec can still set its own `groupId` to opt into a different
 * (e.g. child-only) group.
 */
export const makeParent = async (
  spec: {
    parent?: ListingSpec;
    children?: ListingSpec[];
    group?: Parameters<typeof createTestGroup>[0];
  } = {},
): Promise<{
  parent: ListingWithCount;
  /** The first (and, for the common single-child scenario, only) child — a
   * convenience so a test can `const { parent, child } = await makeParent(...)`
   * instead of reaching into `children[0]`. */
  child: ListingWithCount;
  children: ListingWithCount[];
  group?: Group | undefined;
}> => {
  const group = spec.group ? await createTestGroup(spec.group) : undefined;
  const groupId = group?.id;
  const withGroup = (s: ListingSpec): ListingSpec =>
    groupId !== undefined && s.groupId === undefined ? { groupId, ...s } : s;

  const parent = await makeListing(
    withGroup({ thankYouUrl: "", ...spec.parent }),
    "Parent",
  );
  const childSpecs = spec.children ?? [{}];
  const children: ListingWithCount[] = [];
  for (let i = 0; i < childSpecs.length; i++) {
    children.push(
      await makeListing(withGroup(childSpecs[i]!), `Child ${i + 1}`),
    );
  }
  await listingChildren.setIds(
    parent.id,
    children.map((c) => c.id),
  );
  return { child: children[0]!, children, group, parent };
};

/**
 * Build the "a group whose only standalone member is a sold-out parent"
 * scenario shared by the `/listings` CTA suppression and the group-QR 404
 * tests: a `createTestGroup` + parent placed in that group + a single-spot
 * child sold out via `createTestAttendee`, with the parent→child edge wired.
 * Both the CTA-suppression and the QR-404 paths exercise the same dead-member
 * setup, so it lives once here — only the group name (for assertion clarity)
 * varies between callers.
 */
export const soldOutParentInGroup = async (
  groupName: string,
): Promise<{
  child: ListingWithCount;
  group: Group;
  parent: ListingWithCount;
}> => {
  const group = await createTestGroup({ name: groupName });
  const parent = await createTestListing({
    groupId: group.id,
    name: "Base in group",
  });
  const child = await createTestListing({
    maxAttendees: 1,
    name: "Sold-out add-on",
  });
  await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, group, parent };
};

/**
 * Enable the public site and assert `/listings` does NOT advertise a Book CTA
 * pointing at `groupSlug` — i.e. the dead-group link the page must not render.
 * The shared shape behind the two `/listings` CTA-suppression tests: turn the
 * site on, GET `/listings`, assert the `href="/ticket/<group>"` link is absent.
 */
export const expectNoListingsCta = async (groupSlug: string): Promise<void> => {
  await enablePublicSite();
  const body = await testPageHtml("/listings");
  assert(!body.includes(`href="/ticket/${groupSlug}"`));
};
