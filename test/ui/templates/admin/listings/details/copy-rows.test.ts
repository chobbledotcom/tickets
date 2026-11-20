import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
      canPayMore: true,
      maxPrice: 2000,
      unitPrice: 1500,
    });
    expectIncludesAll(rows, [
      "<th>Ticket Price</th>",
      "£15",
      "pay more: £15–£20",
    ]);
  });

  test("pay-more without headroom names the enabled state", () => {
    const rows = detailRows({
      canPayMore: true,
      maxPrice: 1000,
      unitPrice: 1000,
    });
    expectIncludesAll(rows, ["£10", "pay more enabled"]);
  });

  test("a free listing without pay-more says Free, with no suffix", () => {
    const rows = detailRows({ canPayMore: false, unitPrice: 0 });
    assertStringIncludes(rows, "<td>Free</td>");
    assert(!rows.includes("pay more"));
  });

  test("one minor unit is a price, not Free", () => {
    const rows = detailRows({ unitPrice: 1 });
    assert(!rows.includes("<td>Free</td>"));
  });

  test("a customisable-days listing prices each offered day count", () => {
    const rows = detailRows({
      customisableDays: true,
      dayPrices: { 1: 1000, 3: 2500 },
      durationDays: 4,
      listingType: "daily",
    });
    // The chooser sentence and the price list share one space.
    expectIncludesAll(rows, [
      "Visitors choose 1–4 days. <span>1 day: £10",
      "1 day: £10, 3 days: £25",
    ]);
  });

  test("one offered day count still prices it", () => {
    const rows = detailRows({
      customisableDays: true,
      dayPrices: { 1: 1200 },
      listingType: "daily",
    });
    assertStringIncludes(rows, "<span>1 day: £12</span>");
  });

  test("customisable days with no day prices says so", () => {
    const rows = detailRows({
      customisableDays: true,
      dayPrices: {},
      listingType: "daily",
    });
    assertStringIncludes(rows, "No day prices set");
  });

  test("a daily listing's schedule rows name the window and duration", () => {
    const rows = detailRows({
      bookableDays: ["Monday", "Tuesday"],
      durationDays: 3,
      listingType: "daily",
      maximumDaysAfter: 10,
      minimumDaysBefore: 2,
    });
    expectIncludesAll(rows, [
      "<th>Listing Type</th><td>Daily</td>",
      "<th>Bookable Days</th>",
      "Monday, Tuesday",
      "<th>Booking Window</th>",
      "2 to 10 days from today",
      "<th>Booking duration</th>",
      "<td>3 day(s)</td>",
    ]);
  });

  test("an unlimited booking window says unlimited", () => {
    const rows = detailRows({
      listingType: "daily",
      maximumDaysAfter: 0,
      minimumDaysBefore: 0,
    });
    assertStringIncludes(rows, "0 to unlimited days from today");
  });

  test("renewal, non-transferable, and hidden rows render their facts", () => {
    const rows = detailRows({
      hidden: true,
      monthsPerUnit: 1,
      nonTransferable: true,
    });
    expectIncludesAll(rows, [
      "<th>Renewal</th>",
      "<td>1 month(s) per ticket</td>",
      "<th>Non-Transferable</th>",
      "<td>Yes — ID verification required at entry</td>",
      "<th>Hidden</th>",
      "<td>Yes — not shown in public listings list</td>",
    ]);
  });

  test("a child shows no public link or embed rows", () => {
    const child = detailRows({});
    assertStringIncludes(child, 'id="embed-toggle-1"');

    const suppressedChild = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({ id: 12 }),
      publicPage: "child",
    });
    assertStringIncludes(
      suppressedChild,
      "offered as a child of another listing",
    );
    expectExcludesAll(suppressedChild, [
      'id="embed-toggle-12"',
      'id="embed-script-12"',
      'id="embed-iframe-12"',
    ]);
  });

  test("an inactive listing names its switched-off page instead of the links", () => {
    const inactive = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({ id: 12 }),
      publicPage: "inactive",
    });
    assertStringIncludes(inactive, "This listing is inactive");
    expectExcludesAll(inactive, [
      'id="embed-toggle-12"',
      'id="embed-script-12"',
      'id="embed-iframe-12"',
    ]);
  });

  test("the public url row toggles the embed inputs beside the link", () => {
    const rows = detailRows({ id: 30 });
    expectIncludesAll(rows, [
      '<label class="small-action" for="embed-toggle-30">Embed</label>',
      'class="visually-hidden embed-toggle" id="embed-toggle-30" type="checkbox"',
      'id="embed-script-30"',
      'id="embed-iframe-30"',
    ]);
  });

  test("thank-you and webhook urls become copyable rows when present", () => {
    const rows = detailRows({
      location: "The Old Mill",
      thankYouUrl: "https://example.com/thanks",
      webhookUrl: "https://example.com/hook",
    });
    expectIncludesAll(rows, [
      "<th>Location</th><td>The Old Mill</td>",
      'for="thank-you-url-1">Thank You URL</label>',
      'value="https://example.com/thanks"',
      'for="webhook-url-1">Webhook URL</label>',
      'value="https://example.com/hook"',
      // The embed rows carry the class the embed toggle styles live on.
      '<tr class="embed-code-row"><th>',
    ]);
    expect((rows.match(/class="embed-code-row"/g) ?? []).length).toBe(2);
  });

  test("omitted thank-you and webhook urls leave no empty rows", () => {
    const rows = detailRows({ date: "", thankYouUrl: "", webhookUrl: "" });
    // With no date and no location, neither conditional row renders.
    expectExcludesAll(rows, [
      "Thank You URL",
      "Webhook URL",
      "<th>Listing Date</th>",
      "<th>Location</th>",
    ]);
  });

  test("the header row spans both columns with the listing name", () => {
    const rows = detailRows({ name: "Duo Column Camp" });
    assertStringIncludes(rows, '<th colspan="2">Duo Column Camp</th>');
  });
});
