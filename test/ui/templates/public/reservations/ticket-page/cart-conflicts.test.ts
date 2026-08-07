import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

// The ticket page drops any concealed package member from the conflict facts
// before naming a clash, so these cover the plain (nothing concealed) notes the
// buyer sees when the page's items can't be booked together.
describe("ticketPage (cart conflict notes)", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("warns when the page's daily listings share no available date", () => {
    const html = ticketPage({
      cartDateItems: [
        { dates: ["2026-01-01"], id: 1, name: "Near" },
        { dates: ["2026-02-01"], id: 2, name: "Far" },
      ],
      listings: [
        ticketListing({
          id: 1,
          listing_type: "daily",
          name: "Near",
          slug: "near1",
        }),
        ticketListing({
          id: 2,
          listing_type: "daily",
          name: "Far",
          slug: "far01",
        }),
      ],
      slugs: ["near1", "far01"],
    });
    expect(html).toContain(
      "'Near' and 'Far' do not share an available date. Book them separately.",
    );
  });

  test("warns when the page's customisable listings share no booking length", () => {
    const html = ticketPage({
      listings: [
        ticketListing({
          customisable_days: true,
          day_prices: { 1: 500 },
          duration_days: 1,
          id: 1,
          name: "Short",
          slug: "shrt1",
        }),
        ticketListing({
          customisable_days: true,
          day_prices: { 3: 900 },
          duration_days: 3,
          id: 2,
          name: "Long",
          slug: "long1",
        }),
      ],
      slugs: ["shrt1", "long1"],
    });
    expect(html).toContain(
      "'Short' and 'Long' do not share a booking length. Book them separately.",
    );
  });
});
