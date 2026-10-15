import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { adminListingNewPage } from "#templates/admin/listings/form-pages.tsx";
import {
  editPanelHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

describe("adminListingNewPage Advanced section", () => {
  registerListingTemplateHooks();

  test("renders collapsed by default", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    says(html, '<details class="listing-advanced">');
    assert(!html.includes('<details class="listing-advanced" open>'));
  });

  test("opens when re-rendered with an error", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      error: "Something went wrong",
    });
    says(html, '<details class="listing-advanced" open>');
  });
});

describe("adminListingNewPage", () => {
  registerListingTemplateHooks();

  test("renders create listing form fields", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    says(html, "Add Listing");
    says(html, 'name="name"');
    says(html, 'name="max_attendees"');
    says(html, 'name="thank_you_url"');
    says(html, 'name="unit_price"');
    // The shared form keeps the site's own ticket wording on every install.
    says(html, t("fields.listing.price"));
  });

  test("renders breadcrumb back link", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    says(html, 'href="/admin/"');
    says(html, "Listings");
  });

  test("renders group checkboxes when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminListingNewPage(groups, OWNER_SESSION);
    says(html, 'name="group_ids"');
    says(html, 'value="2"');
    says(html, "My Group");
  });

  test("renders error when provided", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      error: "Something went wrong",
    });
    says(html, "Something went wrong");
  });

  test("applies listing-form--hide-type class for templates with a fixed listing_type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "weekly-event",
    });
    says(html, "listing-form--hide-type");
  });

  test("does not apply listing-form--hide-type for templates with no fixed listing_type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    assert(!html.includes("listing-form--hide-type"));
    says(html, "listing-form--templated");
  });

  test("seeds the hireable-item contact fields with phone for delivery contact", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    says(html, 'name="fields" value="email" checked');
    says(html, 'name="fields" value="phone" checked');
    says(html, 'name="fields" value="address" checked');
  });

  test("seeds every weekday into the hireable-item bookable_days", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
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
      says(html, `name="bookable_days" value="${day}" checked`);
    }
  });

  test("applies listing-form--no-daily class for non-daily templates", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "one-off-event",
    });
    says(html, "listing-form--no-daily");
  });

  test("does not apply listing-form--no-daily for templates without a fixed non-daily type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    assert(!html.includes("listing-form--no-daily"));
  });

  test("preserves selected groups on error re-render", () => {
    const groups = [testGroup({ id: 3, name: "Group Three" })];
    const html = adminListingNewPage(groups, OWNER_SESSION, {
      selectedGroupIds: [3],
    });
    says(html, 'value="3"');
    says(html, "checked");
  });

  test("carries custom sentinel through as template_id hidden input", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "custom",
    });
    says(html, 'name="template_id"');
    says(html, 'value="custom"');
  });

  test("carries duplicated_from hidden input when present in submitted values", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      values: { duplicated_from: "42" },
    });
    says(html, 'name="duplicated_from"');
    says(html, 'value="42"');
  });

  test("does not render duplicated_from input when not in submitted values", () => {
    const html = adminListingNewPage([], OWNER_SESSION, { values: {} });
    assert(!html.includes('name="duplicated_from"'));
  });
});

describe("adminListingPage edit form pre-fills date and location", () => {
  registerListingTemplateHooks();

  test("empty date shows no pre-filled value in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendee_count: 0, date: "" }),
    );
    // The date field should render split date and time inputs
    says(html, 'name="date_date"');
    says(html, 'name="date_time"');
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({
        attendee_count: 0,
        date: "2026-06-15T14:00:00.000Z",
      }),
    );
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    says(html, 'value="2026-06-15"');
    says(html, 'value="15:00"');
  });

  test("pre-fills location in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendee_count: 0, location: "Village Hall" }),
    );
    says(html, 'value="Village Hall"');
  });
});

describe("adminListingEditPage max_price field", () => {
  registerListingTemplateHooks();

  // A can_pay_more listing rendered on the edit form for the given max_price.
  const maxPriceEditHtml = (max_price: number) =>
    editPanelHtml(
      testListingWithCount({
        attendee_count: 0,
        can_pay_more: true,
        max_price,
      }),
    );

  test("renders max_price field with value when set", () => {
    const html = maxPriceEditHtml(50000);
    says(html, 'name="max_price"');
    says(html, 'value="500.00"');
  });

  test("renders max_price field with 0.00 when zero", () => {
    const html = maxPriceEditHtml(0);
    says(html, 'name="max_price"');
    says(html, 'value="0.00"');
  });
});
