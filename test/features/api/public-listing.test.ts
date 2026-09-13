import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { resolvedToPublicListing } from "#routes/api/public-listing.ts";
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
