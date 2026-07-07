import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminListingRecalculatePage } from "#templates/admin/listings/aggregates.tsx";
import { ListingEditPanel } from "#templates/admin/listings/edit-panel.tsx";
import { adminListingNewPage } from "#templates/admin/listings/form-pages.tsx";
import { testGroup, testListingWithCount } from "#test-utils";

import { registerListingTemplateHooks, TEST_SESSION } from "./helpers.ts";

registerListingTemplateHooks();

describe("adminListingRecalculatePage", () => {
  test("shows current and attendee-derived totals with checkboxes", () => {
    const listing = testListingWithCount({ name: "Workshop" });
    const html = adminListingRecalculatePage(
      listing,
      {
        booked_quantity: { current: 9, recalculated: 4 },
        tickets_count: { current: 5, recalculated: 2 },
      },
      TEST_SESSION,
    );
    expect(html).toContain("Recalculate: Workshop");
    expect(html).toContain("Current");
    expect(html).toContain("From attendee data");
    expect(html).toContain("Compare the stored listing totals");
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('name="recalculate_fields"');
    expect(html).toContain('value="booked_quantity"');
    expect(html).toContain(">9<");
    expect(html).toContain(">4<");
  });
});

describe("adminListingNewPage Advanced section", () => {
  test("renders collapsed by default", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('<details class="listing-advanced">');
    expect(html).not.toContain('<details class="listing-advanced" open>');
  });

  test("opens when re-rendered with an error", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      error: "Something went wrong",
    });
    expect(html).toContain('<details class="listing-advanced" open>');
  });
});

describe("adminListingNewPage", () => {
  test("renders create listing form fields", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain("Add Listing");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="max_attendees"');
    expect(html).toContain('name="thank_you_url"');
    expect(html).toContain('name="unit_price"');
    expect(html).toContain("Ticket Price");
  });

  test("renders breadcrumb back link", () => {
    const html = adminListingNewPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/"');
    expect(html).toContain("Listings");
  });

  test("renders group checkboxes when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminListingNewPage(groups, TEST_SESSION);
    expect(html).toContain('name="group_ids"');
    expect(html).toContain('value="2"');
    expect(html).toContain("My Group");
  });

  test("renders error when provided", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      error: "Something went wrong",
    });
    expect(html).toContain("Something went wrong");
  });

  test("applies listing-form--hide-type class for templates with a fixed listing_type", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "weekly-event",
    });
    expect(html).toContain("listing-form--hide-type");
  });

  test("does not apply listing-form--hide-type for templates with no fixed listing_type", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "hireable-item",
    });
    expect(html).not.toContain("listing-form--hide-type");
    expect(html).toContain("listing-form--templated");
  });

  test("seeds the hireable-item contact fields with phone for delivery contact", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "hireable-item",
    });
    expect(html).toContain('name="fields" value="email" checked');
    expect(html).toContain('name="fields" value="phone" checked');
    expect(html).toContain('name="fields" value="address" checked');
  });

  test("seeds every weekday into the hireable-item bookable_days", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "hireable-item",
    });
    for (const day of [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]) {
      expect(html).toContain(`name="bookable_days" value="${day}" checked`);
    }
  });

  test("applies listing-form--no-daily class for non-daily templates", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "one-off-event",
    });
    expect(html).toContain("listing-form--no-daily");
  });

  test("does not apply listing-form--no-daily for templates without a fixed non-daily type", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "hireable-item",
    });
    expect(html).not.toContain("listing-form--no-daily");
  });

  test("preserves selected groups on error re-render", () => {
    const groups = [testGroup({ id: 3, name: "Group Three" })];
    const html = adminListingNewPage(groups, TEST_SESSION, {
      selectedGroupIds: [3],
    });
    expect(html).toContain('value="3"');
    expect(html).toContain("checked");
  });

  test("carries custom sentinel through as template_id hidden input", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      templateId: "custom",
    });
    expect(html).toContain('name="template_id"');
    expect(html).toContain('value="custom"');
  });

  test("carries duplicated_from hidden input when present in submitted values", () => {
    const html = adminListingNewPage([], TEST_SESSION, {
      values: { duplicated_from: "42" },
    });
    expect(html).toContain('name="duplicated_from"');
    expect(html).toContain('value="42"');
  });

  test("does not render duplicated_from input when not in submitted values", () => {
    const html = adminListingNewPage([], TEST_SESSION, { values: {} });
    expect(html).not.toContain('name="duplicated_from"');
  });
});

describe("adminListingPage edit form pre-fills date and location", () => {
  test("empty date shows no pre-filled value in edit form", () => {
    const listing = testListingWithCount({ attendee_count: 0, date: "" });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // The date field should render split date and time inputs
    expect(html).toContain('name="date_date"');
    expect(html).toContain('name="date_time"');
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      date: "2026-06-15T14:00:00.000Z",
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    expect(html).toContain('value="2026-06-15"');
    expect(html).toContain('value="15:00"');
  });

  test("pre-fills location in edit form", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      location: "Village Hall",
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain('value="Village Hall"');
  });
});

describe("adminListingEditPage max_price field", () => {
  test("renders max_price field with value when set", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 50000,
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="500.00"');
  });

  test("renders max_price field with 0.00 when zero", () => {
    const listing = testListingWithCount({
      attendee_count: 0,
      can_pay_more: true,
      max_price: 0,
    });
    const html = String(
      ListingEditPanel({ groups: [], listing, session: TEST_SESSION }),
    );
    expect(html).toContain('name="max_price"');
    expect(html).toContain('value="0.00"');
  });
});
