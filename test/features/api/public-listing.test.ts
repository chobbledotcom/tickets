import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { listingChildren } from "#db/listing-parents.ts";
import {
  buildChildPublicListings,
  mapParentChildren,
  resolvedToPublicListing,
} from "#routes/api/public-listing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

const listing = (overrides: Partial<ListingWithCount> = {}): ListingWithCount =>
  ({
    active: true,
    assign_built_site: false,
    attendee_count: 0,
    bookable_alone: false,
    bookable_days: [],
    can_pay_more: false,
    customisable_days: false,
    date: "",
    day_prices: {},
    description: "",
    duration_days: 1,
    fields: "email",
    hidden: false,
    id: 1,
    image_alt_text: "",
    image_url: "",
    initial_site_months: 0,
    listing_type: "standard",
    location: "",
    max_attendees: 100,
    max_price: 10000,
    max_quantity: 5,
    months_per_unit: 0,
    name: "Gala",
    non_transferable: false,
    purchase_only: false,
    slug: "gala",
    slug_index: "gala" as BlindIndex,
    thank_you_url: "",
    tickets_count: 0,
    unit_price: 1000,
    ...overrides,
  }) as ListingWithCount;

const resolved = (overrides: Partial<ListingWithCount> = {}) =>
  buildTicketListing(listing(overrides), false, undefined);

describe("resolvedToPublicListing plan facts", () => {
  test("a plan exposes its flag and the term each unit buys", () => {
    const result = resolvedToPublicListing(
      resolved({ assign_built_site: true, initial_site_months: 3 }),
      undefined,
    );
    expect(result.assignBuiltSite).toBe(true);
    expect(result.initialSiteMonths).toBe(3);
  });

  test("an ordinary listing carries the flag and no term", () => {
    const result = resolvedToPublicListing(resolved(), undefined);
    expect(result.assignBuiltSite).toBe(false);
    expect(Object.hasOwn(result, "initialSiteMonths")).toBe(false);
  });
});

describe("resolvedToPublicListing boundary values", () => {
  test("renders an empty date, location, and image as null", () => {
    const result = resolvedToPublicListing(resolved(), undefined);
    expect(result.date).toBeNull();
    expect(result.imageUrl).toBeNull();
    expect(result.imageAltText).toBeNull();
    expect(result.location).toBeNull();
  });

  test("keeps a set date, location, and image value", () => {
    const result = resolvedToPublicListing(
      resolved({
        date: "2026-06-01",
        image_alt_text: "A poster",
        image_url: "poster.webp",
        location: "Village Hall",
      }),
      undefined,
    );
    expect(result.date).toBe("2026-06-01");
    expect(result.imageUrl).toBe("poster.webp");
    expect(result.imageAltText).toBe("A poster");
    expect(result.location).toBe("Village Hall");
  });
});

describeWithEnv("public listing children", { db: true }, () => {
  test("a parent with one child publishes it", async () => {
    const parent = await createTestListing({ name: "Solo Parent" });
    const child = await createTestListing({ name: "Only Child" });
    await listingChildren.setIds(parent.id, [child.id]);

    expect(await mapParentChildren(parent, (c) => c.id)).toEqual([child.id]);
  });

  test("a listing with no children maps to null, not an empty array", async () => {
    const listing = await createTestListing({ name: "Loner" });

    expect(await mapParentChildren(listing, (c) => c.id)).toBeNull();
  });

  test("publishes an active daily child with its dates, never an inactive one", async () => {
    const parent = await createTestListing({ name: "Daily Parent" });
    const daily = await createDailyTestListing({ name: "Daily Child" });
    const inactive = await createTestListing({ name: "Inactive Child" });
    await deactivateTestListing(inactive.id);
    await listingChildren.setIds(parent.id, [daily.id, inactive.id]);

    const children = await buildChildPublicListings(parent);

    expect(children.map((c) => c.slug)).toEqual([daily.slug]);
    expect(children[0]!.listingType).toBe("daily");
    expect(Array.isArray(children[0]!.availableDates)).toBe(true);
  });

  test("an active standard child carries no availableDates", async () => {
    const parent = await createTestListing({ name: "Plain Parent" });
    const child = await createTestListing({ name: "Plain Child" });
    await listingChildren.setIds(parent.id, [child.id]);

    const children = await buildChildPublicListings(parent);

    expect(children.map((c) => c.slug)).toEqual([child.slug]);
    expect("availableDates" in children[0]!).toBe(false);
  });
});
