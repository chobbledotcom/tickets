/** Shared fixtures and page assertions for the parent/child discovery suites:
 *  the declarative parent scenarios and the /listings card-state asserts that
 *  more than one discovery suite reads. */

import { expect } from "@std/expect";
import { listingChildren } from "#db/listing-parents.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent, publicBody } from "#test-utils/parents.ts";

/** A sold-out child (maxAttendees 1, one attendee) under a single parent. */
export const setupSoldOutChild = async () => {
  const parent = await createTestListing({ name: "Base unit" });
  const child = await createTestListing({ maxAttendees: 1, name: "Add-on" });
  await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

/** A 3-day fixed parent with a customisable daily child.
 * Pass `bookableDays` to restrict the child (e.g. Monday-only). */
export const makeThreeDayParent = (bookableDays?: string[]) =>
  makeParent({
    children: [
      {
        ...(bookableDays && { bookableDays }),
        customisableDays: true,
        daily: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        name: "Span add-on",
      },
    ],
    parent: {
      customisableDays: false,
      daily: true,
      durationDays: 3,
      name: "3-day base",
    },
  });

/** A 2-spot capped group (parent + child share it) with one spot already
 * consumed by a filler member. Returns the group, parent, and filler. */
export const setupOneSpotPool = async () => {
  const { group, parent } = await makeParent({
    children: [{ name: "Add-on" }],
    group: { maxAttendees: 2, name: "Pool" },
    parent: { name: "Base unit" },
  });
  const filler = await createTestListing({
    groupId: group!.id,
    name: "Filler",
  });
  await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");
  return { group, parent };
};

/** A 2-spot capped group (parent + child share it) with no spots consumed. */
export const makeTwoSpotPool = () =>
  makeParent({
    children: [{ name: "Add-on" }],
    group: { maxAttendees: 2, name: "Pool" },
    parent: { name: "Base unit" },
  });

/** Default parent + child pair for tests that don't need specific names. */
export const makeDefaultParentChild = () =>
  makeParent({
    children: [{ name: "Add-on" }],
    parent: { name: "Base unit" },
  });

/** Assert the parent's Book link is absent and Sold Out is shown. */
export const assertSoldOut = async (parentSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).not.toContain(`href="/ticket/${parentSlug}"`);
  expect(body).toContain("Sold Out");
};

/** Assert the parent's Book link is present. */
export const assertBookable = async (parentSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).toContain(`href="/ticket/${parentSlug}"`);
};

/** Assert the add-on note is shown and the child has no standalone link. */
export const assertAddOnNote = async (childSlug: string) => {
  const body = await publicBody("/listings");
  expect(body).toContain("Available as an add-on to another booking");
  expect(body).not.toContain(`href="/ticket/${childSlug}"`);
};
