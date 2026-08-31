import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** Render the details table for one listing, roster trimmed away. */
const detailRows = (listing: Parameters<typeof testListingWithCount>[0]) => {
  const html = renderListingDetail({
    allowedDomain: "localhost",
    attendees: [],
    listing: testListingWithCount(listing),
  });
  const start = html.indexOf('<div class="table-scroll">');
  const end = html.indexOf("</article>", start);
  return html.slice(start, end === -1 ? undefined : end);
};

describe("listing details table copy rows", () => {
  registerListingTemplateHooks();

  test("a priced listing shows its price and pay-more range", () => {
    const rows = detailRows({
      can_pay_more: true,
      max_price: 2000,
      unit_price: 1500,
    });
    expect(rows).toContain("<th>Ticket Price</th>");
    expect(rows).toContain("£15");
    expect(rows).toContain("pay more: £15–£20");
  });

  test("pay-more without headroom names the enabled state", () => {
    const rows = detailRows({
      can_pay_more: true,
      max_price: 1000,
      unit_price: 1000,
    });
    expect(rows).toContain("£10");
    expect(rows).toContain("pay more enabled");
  });

  test("a free listing without pay-more says Free, with no suffix", () => {
    const rows = detailRows({ can_pay_more: false, unit_price: 0 });
    expect(rows).toContain("<td>Free</td>");
    expect(rows).not.toContain("pay more");
  });

  test("one minor unit is a price, not Free", () => {
    const rows = detailRows({ unit_price: 1 });
    expect(rows).not.toContain("<td>Free</td>");
  });

  test("a customisable-days listing prices each offered day count", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: { 1: 1000, 3: 2500 },
      duration_days: 4,
      listing_type: "daily",
    });
    // The chooser sentence and the price list share one space.
    expect(rows).toContain("Visitors choose 1–4 days. <span>1 day: £10");
    expect(rows).toContain("1 day: £10, 3 days: £25");
  });

  test("one offered day count still prices it", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: { 1: 1200 },
      listing_type: "daily",
    });
    expect(rows).toContain("<span>1 day: £12</span>");
  });

  test("customisable days with no day prices says so", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: {},
      listing_type: "daily",
    });
    expect(rows).toContain("No day prices set");
  });

  test("a daily listing's schedule rows name the window and duration", () => {
    const rows = detailRows({
      bookable_days: ["Monday", "Tuesday"],
      duration_days: 3,
      listing_type: "daily",
      maximum_days_after: 10,
      minimum_days_before: 2,
    });
    expect(rows).toContain("<th>Listing Type</th><td>Daily</td>");
    expect(rows).toContain("<th>Bookable Days</th>");
    expect(rows).toContain("Monday, Tuesday");
    expect(rows).toContain("<th>Booking Window</th>");
    expect(rows).toContain("2 to 10 days from today");
    expect(rows).toContain("<th>Booking duration</th>");
    expect(rows).toContain("<td>3 day(s)</td>");
  });

  test("an unlimited booking window says unlimited", () => {
    const rows = detailRows({
      listing_type: "daily",
      maximum_days_after: 0,
      minimum_days_before: 0,
    });
    expect(rows).toContain("0 to unlimited days from today");
  });

  test("renewal, non-transferable, and hidden rows render their facts", () => {
    const rows = detailRows({
      hidden: true,
      months_per_unit: 1,
      non_transferable: true,
    });
    expect(rows).toContain("<th>Renewal</th>");
    expect(rows).toContain("<td>1 month(s) per ticket</td>");
    expect(rows).toContain("<th>Non-Transferable</th>");
    expect(rows).toContain("<td>Yes — ID verification required at entry</td>");
    expect(rows).toContain("<th>Hidden</th>");
    expect(rows).toContain("<td>Yes — not shown in public listings list</td>");
  });

  test("a child or hidden package member shows no public link or embed rows", () => {
    const child = detailRows({});
    expect(child).toContain('id="embed-toggle-1"');

    const suppressedChild = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      isChild: true,
      listing: testListingWithCount({ id: 12 }),
    });
    expect(suppressedChild).toContain("offered as a child of another listing");
    expect(suppressedChild).not.toContain('id="embed-toggle-12"');
    expect(suppressedChild).not.toContain('id="embed-script-12"');
    expect(suppressedChild).not.toContain('id="embed-iframe-12"');

    const suppressedMember = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      isHiddenPackageMember: true,
      listing: testListingWithCount({ id: 12 }),
    });
    expect(suppressedMember).toContain("hides its listings");
    expect(suppressedMember).not.toContain('id="embed-toggle-12"');
  });

  test("the public url row toggles the embed inputs beside the link", () => {
    const rows = detailRows({ id: 30 });
    expect(rows).toContain(
      '<label for="embed-toggle-30">Public URL<span class="embed-toggle-badge">embed</span></label>',
    );
    expect(rows).toContain(
      'class="visually-hidden listing-embed-toggle" id="embed-toggle-30" type="checkbox"',
    );
    expect(rows).toContain('id="embed-script-30"');
    expect(rows).toContain('id="embed-iframe-30"');
  });

  test("thank-you and webhook urls become copyable rows when present", () => {
    const rows = detailRows({
      location: "The Old Mill",
      thank_you_url: "https://example.com/thanks",
      webhook_url: "https://example.com/hook",
    });
    expect(rows).toContain("<th>Location</th><td>The Old Mill</td>");
    expect(rows).toContain('for="thank-you-url-1">Thank You URL</label>');
    expect(rows).toContain('value="https://example.com/thanks"');
    expect(rows).toContain('for="webhook-url-1">Webhook URL</label>');
    expect(rows).toContain('value="https://example.com/hook"');
    // The embed rows carry the class the embed toggle styles live on.
    expect(rows).toContain('<tr class="listing-embed-row"><th>');
    expect((rows.match(/class="listing-embed-row"/g) ?? []).length).toBe(2);
  });

  test("omitted thank-you and webhook urls leave no empty rows", () => {
    const rows = detailRows({ date: "", thank_you_url: "", webhook_url: "" });
    expect(rows).not.toContain("Thank You URL");
    expect(rows).not.toContain("Webhook URL");
    // With no date and no location, neither conditional row renders.
    expect(rows).not.toContain("<th>Listing Date</th>");
    expect(rows).not.toContain("<th>Location</th>");
  });

  test("the header row spans both columns with the listing name", () => {
    const rows = detailRows({ name: "Duo Column Camp" });
    expect(rows).toContain('<th colspan="2">Duo Column Camp</th>');
  });
});
