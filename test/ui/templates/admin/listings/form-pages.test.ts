import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { adminListingNewPage } from "#templates/admin/listings/form-pages.tsx";
import {
  editPanelHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";

describe("adminListingNewPage Advanced section", () => {
  registerListingTemplateHooks();

  test("renders collapsed by default", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    assertStringIncludes(html, '<details class="listing-advanced">');
    assert(
      !html.includes('<details class="listing-advanced" open>'),
      "the value should not contain the searched item",
    );
  });

  test("opens when re-rendered with an error", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      error: "Something went wrong",
    });
    assertStringIncludes(html, '<details class="listing-advanced" open>');
  });
});

describe("adminListingNewPage", () => {
  registerListingTemplateHooks();

  test("renders create listing form fields", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    assertStringIncludes(html, "Add Listing");
    assertStringIncludes(html, 'name="name"');
    assertStringIncludes(html, 'name="max_attendees"');
    assertStringIncludes(html, 'name="thank_you_url"');
    assertStringIncludes(html, 'name="unit_price"');
    // The shared form keeps the site's own ticket wording on every install.
    assertStringIncludes(html, t("fields.listing.price"));
  });

  test("renders breadcrumb back link", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    assertStringIncludes(html, 'href="/admin/"');
    assertStringIncludes(html, "Listings");
  });

  test("renders group checkboxes when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminListingNewPage(groups, OWNER_SESSION);
    assertStringIncludes(html, 'name="group_ids"');
    assertStringIncludes(html, 'value="2"');
    assertStringIncludes(html, "My Group");
  });

  test("renders error when provided", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      error: "Something went wrong",
    });
    assertStringIncludes(html, "Something went wrong");
  });

  test("applies listing-form--hide-type class for templates with a fixed listing_type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "weekly-event",
    });
    assertStringIncludes(html, "listing-form--hide-type");
  });

  test("does not apply listing-form--hide-type for templates with no fixed listing_type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    assert(
      !html.includes("listing-form--hide-type"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "listing-form--templated");
  });

  test("seeds the hireable-item contact fields with phone for delivery contact", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    assertStringIncludes(html, 'name="fields" value="email" checked');
    assertStringIncludes(html, 'name="fields" value="phone" checked');
    assertStringIncludes(html, 'name="fields" value="address" checked');
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
      assertStringIncludes(html, `name="bookable_days" value="${day}" checked`);
    }
  });

  test("applies listing-form--no-daily class for non-daily templates", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "one-off-event",
    });
    assertStringIncludes(html, "listing-form--no-daily");
  });

  test("does not apply listing-form--no-daily for templates without a fixed non-daily type", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "hireable-item",
    });
    assert(
      !html.includes("listing-form--no-daily"),
      "the value should not contain the searched item",
    );
  });

  test("preserves selected groups on error re-render", () => {
    const groups = [testGroup({ id: 3, name: "Group Three" })];
    const html = adminListingNewPage(groups, OWNER_SESSION, {
      selectedGroupIds: [3],
    });
    assertStringIncludes(html, 'value="3"');
    assertStringIncludes(html, "checked");
  });

  test("carries custom sentinel through as template_id hidden input", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      templateId: "custom",
    });
    assertStringIncludes(html, 'name="template_id"');
    assertStringIncludes(html, 'value="custom"');
  });

  test("carries duplicated_from hidden input when present in submitted values", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      values: { duplicated_from: "42" },
    });
    assertStringIncludes(html, 'name="duplicated_from"');
    assertStringIncludes(html, 'value="42"');
  });

  test("does not render duplicated_from input when not in submitted values", () => {
    const html = adminListingNewPage([], OWNER_SESSION, { values: {} });
    assert(
      !html.includes('name="duplicated_from"'),
      "the value should not contain the searched item",
    );
  });
});

describe("adminListingPage edit form pre-fills date and location", () => {
  registerListingTemplateHooks();

  test("empty date shows no pre-filled value in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendee_count: 0, date: "" }),
    );
    // The date field should render split date and time inputs
    assertStringIncludes(html, 'name="date_date"');
    assertStringIncludes(html, 'name="date_time"');
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({
        attendee_count: 0,
        date: "2026-06-15T14:00:00.000Z",
      }),
    );
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    assertStringIncludes(html, 'value="2026-06-15"');
    assertStringIncludes(html, 'value="15:00"');
  });

  test("pre-fills location in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendee_count: 0, location: "Village Hall" }),
    );
    assertStringIncludes(html, 'value="Village Hall"');
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
    assertStringIncludes(html, 'name="max_price"');
    assertStringIncludes(html, 'value="500.00"');
  });

  test("renders max_price field with 0.00 when zero", () => {
    const html = maxPriceEditHtml(0);
    assertStringIncludes(html, 'name="max_price"');
    assertStringIncludes(html, 'value="0.00"');
  });
});
