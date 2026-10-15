// jscpd:ignore-start
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

// jscpd:ignore-end

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
    says(rows, "<th>Ticket Price</th>");
    says(rows, "£15");
    says(rows, "pay more: £15–£20");
  });

  test("pay-more without headroom names the enabled state", () => {
    const rows = detailRows({
      can_pay_more: true,
      max_price: 1000,
      unit_price: 1000,
    });
    says(rows, "£10");
    says(rows, "pay more enabled");
  });

  test("a free listing without pay-more says Free, with no suffix", () => {
    const rows = detailRows({ can_pay_more: false, unit_price: 0 });
    says(rows, "<td>Free</td>");
    assert(!rows.includes("pay more"));
  });

  test("one minor unit is a price, not Free", () => {
    const rows = detailRows({ unit_price: 1 });
    assert(!rows.includes("<td>Free</td>"));
  });

  test("a customisable-days listing prices each offered day count", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: { 1: 1000, 3: 2500 },
      duration_days: 4,
      listing_type: "daily",
    });
    // The chooser sentence and the price list share one space.
    says(rows, "Visitors choose 1–4 days. <span>1 day: £10");
    says(rows, "1 day: £10, 3 days: £25");
  });

  test("one offered day count still prices it", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: { 1: 1200 },
      listing_type: "daily",
    });
    says(rows, "<span>1 day: £12</span>");
  });

  test("customisable days with no day prices says so", () => {
    const rows = detailRows({
      customisable_days: true,
      day_prices: {},
      listing_type: "daily",
    });
    says(rows, "No day prices set");
  });

  test("a daily listing's schedule rows name the window and duration", () => {
    const rows = detailRows({
      bookable_days: ["Monday", "Tuesday"],
      duration_days: 3,
      listing_type: "daily",
      maximum_days_after: 10,
      minimum_days_before: 2,
    });
    says(rows, "<th>Listing Type</th><td>Daily</td>");
    says(rows, "<th>Bookable Days</th>");
    says(rows, "Monday, Tuesday");
    says(rows, "<th>Booking Window</th>");
    says(rows, "2 to 10 days from today");
    says(rows, "<th>Booking duration</th>");
    says(rows, "<td>3 day(s)</td>");
  });

  test("an unlimited booking window says unlimited", () => {
    const rows = detailRows({
      listing_type: "daily",
      maximum_days_after: 0,
      minimum_days_before: 0,
    });
    says(rows, "0 to unlimited days from today");
  });

  test("renewal, non-transferable, and hidden rows render their facts", () => {
    const rows = detailRows({
      hidden: true,
      months_per_unit: 1,
      non_transferable: true,
    });
    says(rows, "<th>Renewal</th>");
    says(rows, "<td>1 month(s) per ticket</td>");
    says(rows, "<th>Non-Transferable</th>");
    says(rows, "<td>Yes — ID verification required at entry</td>");
    says(rows, "<th>Hidden</th>");
    says(rows, "<td>Yes — not shown in public listings list</td>");
  });

  test("a child shows no public link or embed rows", () => {
    const child = detailRows({});
    says(child, 'id="embed-toggle-1"');

    const suppressedChild = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({ id: 12 }),
      publicPage: "child",
    });
    says(suppressedChild, "offered as a child of another listing");
    assert(!suppressedChild.includes('id="embed-toggle-12"'));
    assert(!suppressedChild.includes('id="embed-script-12"'));
    assert(!suppressedChild.includes('id="embed-iframe-12"'));
  });

  test("an inactive listing names its switched-off page instead of the links", () => {
    const inactive = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({ id: 12 }),
      publicPage: "inactive",
    });
    says(inactive, "This listing is inactive");
    assert(!inactive.includes('id="embed-toggle-12"'));
    assert(!inactive.includes('id="embed-script-12"'));
    assert(!inactive.includes('id="embed-iframe-12"'));
  });

  test("the public url row toggles the embed inputs beside the link", () => {
    const rows = detailRows({ id: 30 });
    says(
      rows,
      '<label class="small-action" for="embed-toggle-30">Embed</label>',
    );
    says(
      rows,
      'class="visually-hidden embed-toggle" id="embed-toggle-30" type="checkbox"',
    );
    says(rows, 'id="embed-script-30"');
    says(rows, 'id="embed-iframe-30"');
  });

  test("thank-you and webhook urls become copyable rows when present", () => {
    const rows = detailRows({
      location: "The Old Mill",
      thank_you_url: "https://example.com/thanks",
      webhook_url: "https://example.com/hook",
    });
    says(rows, "<th>Location</th><td>The Old Mill</td>");
    says(rows, 'for="thank-you-url-1">Thank You URL</label>');
    says(rows, 'value="https://example.com/thanks"');
    says(rows, 'for="webhook-url-1">Webhook URL</label>');
    says(rows, 'value="https://example.com/hook"');
    // The embed rows carry the class the embed toggle styles live on.
    says(rows, '<tr class="embed-code-row"><th>');
    expect((rows.match(/class="embed-code-row"/g) ?? []).length).toBe(2);
  });

  test("omitted thank-you and webhook urls leave no empty rows", () => {
    const rows = detailRows({ date: "", thank_you_url: "", webhook_url: "" });
    assert(!rows.includes("Thank You URL"));
    assert(!rows.includes("Webhook URL"));
    // With no date and no location, neither conditional row renders.
    assert(!rows.includes("<th>Listing Date</th>"));
    assert(!rows.includes("<th>Location</th>"));
  });

  test("the header row spans both columns with the listing name", () => {
    const rows = detailRows({ name: "Duo Column Camp" });
    says(rows, '<th colspan="2">Duo Column Camp</th>');
  });
});
