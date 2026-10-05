import { expect } from "@std/expect";
import { queryAll } from "#db/client.ts";
import { setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { handleRequest } from "#routes";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createFlexPackage } from "#test-utils/packages.ts";
import { apiGet } from "#test-utils/parents.ts";

/** POST /api/packages/:slug/book with a minimal valid contact payload merged
 * with any extra body fields (quantity, date, dayCount, children). */
export const apiBookPackage = async (
  slug: string,
  extra: Record<string, unknown> = {},
  rawBody?: string,
): Promise<{
  response: Response;
  body: {
    booking?: {
      amountOwed: number;
      checkoutUrl?: string;
      ticketToken: string;
    };
    error?: string;
  };
}> => {
  const response = await handleRequest(
    new Request(`http://localhost/api/packages/${slug}/book`, {
      body:
        rawBody ??
        JSON.stringify({ email: "pkg@test.com", name: "Pkg Buyer", ...extra }),
      headers: { "content-type": "application/json", host: "localhost" },
      method: "POST",
    }),
  );
  return { body: await response.json(), response };
};

export const expectPackageNeedsEmail = async (slug: string): Promise<void> => {
  const { body, response } = await apiBookPackage(
    slug,
    {},
    JSON.stringify({ name: "No Email" }),
  );
  expect(response.status).toBe(400);
  expect(body.error).toMatch(/email/i);
};

/** The REAL booking rows for a listing (refund placeholders excluded). */
export const bookingRows = (
  listingId: number,
): Promise<
  { quantity: number; package_group_id: number; parent_listing_id: number }[]
> =>
  queryAll(
    `SELECT quantity, package_group_id, parent_listing_id FROM listing_attendees
      WHERE listing_id = ? AND quantity > 0 ORDER BY id DESC`,
    [listingId],
  );

/** A fixed-price two-member package: member A at its own 1000 ×2 per package,
 * member B overridden to 500 — one bundle totals 2500. */
export const fixedPackage = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const a = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} A`,
    unitPrice: 1000,
  });
  const b = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} B`,
    unitPrice: 800,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: a.id, price: null, quantity: 2 },
    { listingId: b.id, price: 500 },
  ]);
  return { a, b, group };
};

/** Two priced child add-ons ("<prefix> Addon" at 300, "<prefix> Addon B" at
 * 400) gated under member `a`. */
export const twoChildAddons = async (a: { id: number }, prefix: string) => {
  const child = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${prefix} Addon`,
    unitPrice: 300,
  });
  const childB = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${prefix} Addon B`,
    unitPrice: 400,
  });
  await listingChildren.setIds(a.id, [child.id, childB.id]);
  return { child, childB };
};

/** A customisable dated package via the shared fixture, with the boat's 2-day
 * span repriced to 1500 in this package — 1 day totals 1500, 2 days 2400. */
export const customisablePackage = (name: string, slug: string) =>
  createFlexPackage(name, slug, { dayPrices: { 2: 1500 }, price: null });

/** Attach `child` as the member's sole add-on and fetch the package detail. */
export const withAddonGetPackage = async (
  memberId: number,
  childId: number,
  slug: string,
): Promise<any> => {
  await listingChildren.setIds(memberId, [childId]);
  return (await (await apiGet(`/api/packages/${slug}`)).json()).package;
};

/** A package of two identical parent-capable members, for the cross-parent
 * child-demand cases (each member gets its add-ons attached by the test). */
export const twoParentPackage = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const memberOpts = {
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    unitPrice: 500,
  };
  const m1 = await createTestListing({ ...memberOpts, name: `${name} A` });
  const m2 = await createTestListing({ ...memberOpts, name: `${name} B` });
  return { group, m1, m2 };
};

/** The package detail's advertised whole-bundle cap. */
export const packageCap = async (slug: string): Promise<number> =>
  (await (await apiGet(`/api/packages/${slug}`)).json()).package
    .maxPurchasable as number;
