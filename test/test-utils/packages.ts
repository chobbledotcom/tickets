/** Package booking-flow test helpers. */

import type { Group, ListingWithCount } from "#types";

/**
 * Drive the public checkout submit for a package group: GET the package page
 * (seeding the CSRF token the POST needs), then POST the booking form fields.
 * Callers pass `package_quantity_<groupId>` plus any date/day-count/contact
 * fields.
 */
export const submitPackageBooking = async (
  slug: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockTicketFormRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");
  const pageHtml = await (
    await handleRequest(mockRequest(`/ticket/${slug}`))
  ).text();
  const csrf = extractCsrfToken(pageHtml)!;
  return handleRequest(mockTicketFormRequest(slug, fields, csrf));
};

/** The package-building pieces both factories below load lazily, so importing
 * this module never pulls the app graph in on its own. */
const packageParts = async () => {
  const { setGroupPackageMembers } = await import("#db/groups.ts");
  const { createTestGroup } = await import("#test-utils/db-helpers/groups.ts");
  const { createTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  return { createTestGroup, createTestListing, setGroupPackageMembers };
};

/** A free one-member package: the member costs 0 inside the bundle, so a
 * booking page prices and books it without a payment provider. `slug` fixes the
 * package's own slug when a test needs to name it in a URL. */
export const createFreePackage = async (
  name: string,
  memberName: string,
  slug?: string,
): Promise<{ group: Group; member: ListingWithCount }> => {
  const { createTestGroup, createTestListing, setGroupPackageMembers } =
    await packageParts();
  const group = await createTestGroup({
    isPackage: true,
    name,
    ...(slug === undefined ? {} : { slug }),
  });
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: memberName,
    unitPrice: 0,
  });
  await setGroupPackageMembers(group.id, [{ listingId: member.id, price: 0 }]);
  return { group, member };
};

/** A customisable dated two-member package — boat (day prices 1000/1800) and
 * hut (500/900), both bookable from tomorrow — with the boat's package
 * overrides applied: `{ price: null }` for none, a flat `price`, and/or
 * per-day `dayPrices` (e.g. `{ 2: 1500 }` reprices its 2-day span). */
export const createFlexPackage = async (
  name: string,
  slug: string,
  boatOverrides: {
    price: number | null;
    dayPrices?: Record<number, number>;
  } = { price: null },
) => {
  const { createTestGroup, createTestListing, setGroupPackageMembers } =
    await packageParts();
  const group = await createTestGroup({ isPackage: true, name, slug });
  const boat = await createTestListing({
    customisableDays: true,
    dayPrices: { 1: 1000, 2: 1800 },
    durationDays: 2,
    groupId: group.id,
    listingType: "daily",
    maxAttendees: 10,
    maxQuantity: 10,
    minimumDaysBefore: 0,
    name: `${name} Boat`,
    unitPrice: 1000,
  });
  const hut = await createTestListing({
    customisableDays: true,
    dayPrices: { 1: 500, 2: 900 },
    durationDays: 2,
    groupId: group.id,
    listingType: "daily",
    maxAttendees: 10,
    maxQuantity: 10,
    minimumDaysBefore: 0,
    name: `${name} Hut`,
    unitPrice: 500,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: boat.id, ...boatOverrides },
    { listingId: hut.id, price: null },
  ]);
  return { boat, group, hut };
};

/** Assert a {@link submitPackageBooking} response is the post-booking success
 * redirect, not an error bounce. */
export const expectPackageBookingAccepted = async (
  submit: Response,
): Promise<void> => {
  const { expect } = await import("@std/expect");
  expect([302, 303]).toContain(submit.status);
  // A 30x always carries a Location header.
  expect(submit.headers.get("location")!).not.toContain("error");
};
