import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ListingEditPanel } from "#templates/admin/listings/edit-panel.tsx";
import { adminListingNewPage } from "#templates/admin/listings/form-pages.tsx";
import {
  editPanelHtml,
  registerListingTemplateHooks,
  TEST_SESSION,
  withBuilder,
} from "#test/templates/admin/listings/helpers.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";

registerListingTemplateHooks();

/** An edit-panel render with both always-open URLs cleared, so only the field
 *  named in `overrides` can force the Advanced disclosure open. */
const ADVANCED_OPEN = '<details class="listing-advanced" open>';
const advancedPanelHtml = (
  overrides: Parameters<typeof testListingWithCount>[0],
  extra: Parameters<typeof editPanelHtml>[1] = {},
): string =>
  editPanelHtml(
    testListingWithCount({ thank_you_url: "", webhook_url: "", ...overrides }),
    extra,
  );

describe("adminListingEditPage group select", () => {
  test("checks the listing's groups when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "Group Two" })];
    const listing = testListingWithCount({});
    const html = String(
      ListingEditPanel({
        groups,
        listing,
        selectedGroupIds: [2],
        session: TEST_SESSION,
      }),
    );
    expect(html).toContain('name="group_ids"');
    expect(html).toContain('value="2"');
    expect(html).toContain("checked");
  });

  test("does not link to the JSON export (that now lives on the Actions tab)", () => {
    const listing = testListingWithCount({ id: 9 });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // The Actions tab is now editor-visible too, so the export link lives
    // only there — the Edit panel no longer duplicates it.
    expect(html).not.toContain(`/admin/listing/${listing.id}/export.json`);
  });
});

describe("adminListingEditPage duration warning", () => {
  test("includes duration warning + confirmation gate with current duration", () => {
    const listing = testListingWithCount({
      duration_days: 3,
      listing_type: "daily",
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain(
      "Changing booking duration will update existing bookings",
    );
    expect(html).toContain('id="duration-warning"');
    expect(html).toContain('id="duration-warning-confirm"');
    // The current duration is exposed via a data attribute so the bundled
    // admin script can compare against the form's input.
    expect(html).toContain('data-duration-original="3"');
  });
});

describe("adminListingEditPage day prices", () => {
  test("renders priced day-count inputs and checks the customisable toggle", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // One input per day up to the maximum duration, pre-filled from day_prices.
    expect(html).toContain('name="day_price_1"');
    expect(html).toContain('value="10.00"');
    expect(html).toContain('name="day_price_2"');
    expect(html).toContain('value="18.00"');
    // The customisable-days checkbox is rendered checked for such a listing.
    expect(html).toContain('name="customisable_days"');
    expect(html).toContain("Day Prices (customisable days)");
  });

  test("renders a single blank day-price row on the new-listing form", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('name="day_price_1"');
    // The maximum defaults to 1 day for a new listing, so only one row shows.
    expect(html).not.toContain('name="day_price_2"');
  });
});

describe("adminListingEditPage form sections", () => {
  test("groups fields under section legends and an Advanced disclosure", () => {
    const listing = testListingWithCount();
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain("<legend>Basics</legend>");
    expect(html).toContain("<legend>Tickets &amp; Pricing</legend>");
    expect(html).toContain("<legend>Daily Scheduling</legend>");
    expect(html).toContain(
      "<legend>Booking Duration &amp; Day Prices</legend>",
    );
    expect(html).toContain("<legend>Options &amp; Visibility</legend>");
    expect(html).toContain("<summary>Advanced settings</summary>");
  });

  test("renders the day-prices block immediately after the customisable-days checkbox", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000 },
      duration_days: 1,
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    const customisableIdx = html.indexOf('name="customisable_days"');
    const dayPriceIdx = html.indexOf('name="day_price_1"');
    const contactFieldsIdx = html.indexOf('name="fields"');
    // The prices follow the checkbox, and both sit before the later Options
    // section — i.e. no longer dumped at the bottom of the form.
    expect(customisableIdx).toBeGreaterThan(-1);
    expect(customisableIdx).toBeLessThan(dayPriceIdx);
    expect(dayPriceIdx).toBeLessThan(contactFieldsIdx);
  });

  test("places the technical fields inside the Advanced disclosure", () => {
    const listing = testListingWithCount();
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    const advancedIdx = html.indexOf("<summary>Advanced settings</summary>");
    expect(advancedIdx).toBeGreaterThan(-1);
    expect(advancedIdx).toBeLessThan(html.indexOf('name="webhook_url"'));
    expect(advancedIdx).toBeLessThan(html.indexOf('name="thank_you_url"'));
    expect(advancedIdx).toBeLessThan(html.indexOf('name="slug"'));
  });

  test("renders editable running totals with a recalculation link", () => {
    const listing = testListingWithCount({
      attendee_count: 7,
      tickets_count: 3,
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain("<legend>Running totals</legend>");
    expect(html).toContain("Accuracy is not guaranteed");
    expect(html).toContain('name="booked_quantity"');
    expect(html).toContain('value="7"');
    expect(html).toContain('name="tickets_count"');
    expect(html).toContain('value="3"');
    // Income is not a count override in the running-totals form — that form keeps
    // only the two count aggregates, which post to the recalculate route.
    const totalsForm = html.slice(
      html.indexOf("<legend>Running totals</legend>"),
      html.indexOf("Adjust income"),
    );
    expect(totalsForm).not.toContain('name="income"');
    expect(html).toContain(`/admin/listings/recalculate/${listing.id}`);
  });

  test("renders the separate income-correction form (decision 14)", () => {
    const listing = testListingWithCount();
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // Income correction stays in a dedicated warned form, apart from counts.
    expect(html).toContain("<h2>Adjust income</h2>");
    expect(html).toContain(`action="/admin/listing/${listing.id}/income"`);
    expect(html).toContain('name="income"');
    expect(html).toContain("This adds a correction to Money history.");
  });

  test("links from the income form to the detail page's money breakdown", () => {
    const listing = testListingWithCount({ id: 4 });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // A compact pointer beside the adjust-income form to the full reconciliation
    // section on the detail page, so the two figures are explained in one place.
    expect(html).toContain('href="/admin/listing/4#income-ledger"');
    expect(html).toContain("Money in and out");
  });

  test("shows a running-total mismatch on the edit page", () => {
    const listing = testListingWithCount({
      attendee_count: 7,
      tickets_count: 3,
    });
    const html = String(
      ListingEditPanel({
        aggregateRecalculation: {
          booked_quantity: { current: 7, recalculated: 4 },
          tickets_count: { current: 3, recalculated: 3 },
        },
        groups: [],
        listing,
        session: TEST_SESSION,
      }),
    );
    expect(html).toContain("Mismatch");
    expect(html).toContain("expected <strong>4</strong>, got");
    expect(html).toContain(`/admin/listings/recalculate/${listing.id}`);
  });
});

describe("adminListingEditPage Advanced section auto-open", () => {
  test("stays collapsed when only the slug is set", () => {
    // Slug is always populated; on its own it must not force the section open.
    const html = advancedPanelHtml({});
    expect(html).toContain('<details class="listing-advanced">');
    expect(html).not.toContain(ADVANCED_OPEN);
  });

  test("opens when a thank-you URL is set", () => {
    const html = advancedPanelHtml({
      thank_you_url: "https://example.com/thanks",
    });
    expect(html).toContain(ADVANCED_OPEN);
  });

  test("opens when a webhook URL is set", () => {
    const html = advancedPanelHtml({
      webhook_url: "https://hooks.example.com/notify",
    });
    expect(html).toContain(ADVANCED_OPEN);
  });

  test("opens on a validation error so hidden fields stay reachable", () => {
    const html = advancedPanelHtml({}, { error: "Bad input" });
    expect(html).toContain(ADVANCED_OPEN);
  });
});

describe("adminListingEditPage Advanced section auto-open (builder fields)", () => {
  test("opens when a renewal tier (months per unit) is set", () => {
    withBuilder(() => {
      expect(advancedPanelHtml({ months_per_unit: 3 })).toContain(
        ADVANCED_OPEN,
      );
    });
  });

  test("opens when initial site months is set", () => {
    withBuilder(() => {
      expect(
        advancedPanelHtml({ initial_site_months: 6, months_per_unit: 0 }),
      ).toContain(ADVANCED_OPEN);
    });
  });

  test("opens when a built site is assigned on booking", () => {
    withBuilder(() => {
      expect(
        advancedPanelHtml({
          assign_built_site: true,
          initial_site_months: 0,
          months_per_unit: 0,
        }),
      ).toContain(ADVANCED_OPEN);
    });
  });

  test("stays collapsed when no advanced field is set even with the builder enabled", () => {
    withBuilder(() => {
      const html = advancedPanelHtml({
        assign_built_site: false,
        initial_site_months: 0,
        months_per_unit: 0,
      });
      expect(html).toContain('<details class="listing-advanced">');
      expect(html).not.toContain(ADVANCED_OPEN);
    });
  });
});
