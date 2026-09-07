import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { pagePackage } from "#test-utils/package-cap-fixtures.ts";

/** The hidden package that conceals listing 1 in these fixtures. */
const hiddenPackage = () => [
  pagePackage(7, [1], {
    hideListings: true,
    name: "Mystery Box",
    slug: "mystery",
  }),
];

/** Two customisable listings whose booking lengths never match: 1 day and
 * 3 days. The first one takes the caller's name and slug so a test can
 * present it standalone or concealed. */
const lengthClashListings = (first: { name: string; slug: string }) => [
  ticketListing({
    customisable_days: true,
    day_prices: { 1: 500 },
    duration_days: 1,
    id: 1,
    ...first,
  }),
  ticketListing({
    customisable_days: true,
    day_prices: { 3: 900 },
    duration_days: 3,
    id: 2,
    name: "Long",
    slug: "long1",
  }),
];

/** A date clash between listing 1 (one bookable day, caller's name and
 * slug) and listing 2 (a different bookable day). */
const dateClash = (first: { name: string; slug: string }) => ({
  cartDateItems: [
    { dates: ["2026-01-01"], id: 1, name: first.name },
    { dates: ["2026-02-01"], id: 2, name: "Far" },
  ],
  listings: [
    ticketListing({ id: 1, listing_type: "daily", ...first }),
    ticketListing({ id: 2, listing_type: "daily", name: "Far", slug: "far01" }),
  ],
});

// The ticket page drops any concealed package member from the conflict facts
// before naming a clash, so these cover the plain (nothing concealed) notes the
// buyer sees when the page's items can't be booked together.
describe("ticketPage (cart conflict notes)", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("warns when the page's daily listings share no available date", () => {
    const html = ticketPage({
      ...dateClash({ name: "Near", slug: "near1" }),
      slugs: ["near1", "far01"],
    });
    expect(html).toContain(
      "'Near' and 'Far' do not share an available date. Book them separately.",
    );
  });

  test("warns when the page's customisable listings share no booking length", () => {
    const html = ticketPage({
      listings: lengthClashListings({ name: "Short", slug: "shrt1" }),
      slugs: ["shrt1", "long1"],
    });
    expect(html).toContain(
      "'Short' and 'Long' do not share a booking length. Book them separately.",
    );
  });

  test("names a member that the cart also sells standalone", () => {
    const html = ticketPage({
      ...dateClash({ name: "Secret Unit", slug: "secret" }),
      packages: hiddenPackage(),
      slugs: ["mystery", "secret", "far01"],
    });

    expect(html).toContain(
      "'Secret Unit' and 'Far' do not share an available date.",
    );
  });
});

// The same filters read the concealment facts: a clash stays silent while the
// page only offers one side of it concealed inside a hidden package, and a
// clash still speaks when the concealed member also has its own page.
describe("ticketPage (concealed cart conflict items)", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("stays silent when the clashing cart date item is only offered concealed", () => {
    const html = ticketPage({
      ...dateClash({ name: "Hidden Unit", slug: "secret" }),
      packages: hiddenPackage(),
      slugs: ["mystery", "far01"],
    });
    expect(html).not.toContain("do not share an available date");
  });

  test("warns about booking lengths for a member the cart also sells standalone", () => {
    const html = ticketPage({
      listings: lengthClashListings({ name: "Short", slug: "shrt1" }),
      packages: hiddenPackage(),
      slugs: ["mystery", "shrt1", "long1"],
    });
    expect(html).toContain(
      "'Short' and 'Long' do not share a booking length. Book them separately.",
    );
  });

  test("stays silent when the clashing customisable listing is only offered concealed", () => {
    const html = ticketPage({
      listings: lengthClashListings({ name: "Hidden Unit", slug: "secret" }),
      packages: hiddenPackage(),
      slugs: ["mystery", "long1"],
    });
    expect(html).not.toContain("do not share a booking length");
  });
});
