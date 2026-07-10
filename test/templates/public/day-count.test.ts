import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#shared/booking/model.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

import { registerPublicTemplateHooks, ticketListing } from "./helpers.ts";

registerPublicTemplateHooks();

describe("ticketPage day-count selector", () => {
  test("renders a priced day-count selector for a single customisable listing", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
      name: "Festival Pass",
      slug: "ab12c",
    });
    const html = ticketPage({
      listings: [buildTicketListing(listing, false, undefined)],
      slugs: ["ab12c"],
    });
    expect(html).toContain('name="day_count"');
    expect(html).toContain('<option value="1">1 day');
    expect(html).toContain('<option value="2">2 days');
    // The single-listing page annotates each option with its price.
    expect(html).toContain("2 days —");
  });

  test("shows an unavailable message when grouped listings share no day count", () => {
    // Two customisable listings offering disjoint counts intersect to nothing,
    // so the shared selector reports that no length is available.
    const a = ticketListing({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000 },
      duration_days: 1,
      id: 1,
      name: "One Day Only",
      slug: "ab12c",
    });
    const b = ticketListing({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 2: 1800 },
      duration_days: 2,
      id: 2,
      name: "Two Days Only",
      slug: "cd34e",
    });
    const html = ticketPage({ listings: [a, b], slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("No booking lengths are currently available.");
    expect(html).not.toContain('<option value="1">1 day');
  });

  test("renders shared day counts without per-option prices across a group", () => {
    // Two customisable listings that both offer a 1-day option share it; with
    // multiple listings there's no single price to show per option.
    const a = ticketListing({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
      id: 1,
      name: "Listing A",
      slug: "ab12c",
    });
    const b = ticketListing({
      attendee_count: 0,
      customisable_days: true,
      day_prices: { 1: 1500, 2: 2400 },
      duration_days: 2,
      id: 2,
      name: "Listing B",
      slug: "cd34e",
    });
    const html = ticketPage({ listings: [a, b], slugs: ["ab12c", "cd34e"] });
    expect(html).toContain('name="day_count"');
    expect(html).toContain('<option value="1">1 day</option>');
    expect(html).toContain('<option value="2">2 days</option>');
  });

  test("omits the day-count selector for non-customisable listings", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      name: "Plain",
      slug: "ab12c",
    });
    const html = ticketPage({
      listings: [buildTicketListing(listing, false, undefined)],
      slugs: ["ab12c"],
    });
    expect(html).not.toContain('name="day_count"');
  });
});
