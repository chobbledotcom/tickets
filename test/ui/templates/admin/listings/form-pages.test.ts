import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { adminListingNewPage } from "#templates/admin/listings/form-pages.tsx";
import {
  editPanelHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll, inputNamed } from "#test-utils/assertions.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";

/** The new-listing form opened from one picker card. */
const newPageFor = (templateId: string): string =>
  adminListingNewPage([], OWNER_SESSION, { templateId });

describe("adminListingNewPage Advanced section", () => {
  registerListingTemplateHooks();

  test("renders collapsed by default", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    assertStringIncludes(html, '<details class="listing-advanced">');
    assert(!html.includes('<details class="listing-advanced" open>'));
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
    expectIncludesAll(html, [
      "Add Listing",
      'name="name"',
      'name="maxAttendees"',
      'name="thankYouUrl"',
      'name="unitPrice"',
      // The shared form keeps the site's own ticket wording on every install.
      t("fields.listing.price"),
    ]);
  });

  test("renders breadcrumb back link", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    expectIncludesAll(html, ['href="/admin/"', "Listings"]);
  });

  test("draws each count box at the value its column takes by default", () => {
    const html = adminListingNewPage([], OWNER_SESSION);
    for (const [name, value] of [
      ["durationDays", "1"],
      ["maximumDaysAfter", "90"],
      ["maxQuantity", "1"],
      ["minimumDaysBefore", "1"],
      ["minQuantity", "1"],
    ] as const) {
      expectIncludesAll(inputNamed(html, name), [
        `value="${value}"`,
        "required",
      ]);
    }
  });

  test("renders group checkboxes when groups exist", () => {
    const groups = [testGroup({ id: 2, name: "My Group" })];
    const html = adminListingNewPage(groups, OWNER_SESSION);
    expectIncludesAll(html, ['name="groupIds"', 'value="2"', "My Group"]);
  });

  test("renders error when provided", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      error: "Something went wrong",
    });
    assertStringIncludes(html, "Something went wrong");
  });

  const TEMPLATE_CLASSES = [
    "listing-form--templated",
    "listing-form--hide-type",
    "listing-form--hide-date",
    "listing-form--no-daily",
  ];
  const formClasses = (templateId: string): string[] => {
    const html = newPageFor(templateId);
    return TEMPLATE_CLASSES.filter((name) => html.includes(name));
  };

  test("gives each template's form the classes that hide what it pins", () => {
    const [templated, hideType, hideDate, noDaily] = TEMPLATE_CLASSES;
    expect({
      "hireable-item": formClasses("hireable-item"),
      "one-off-event": formClasses("one-off-event"),
      subscription: formClasses("subscription"),
      "weekly-event": formClasses("weekly-event"),
    }).toEqual({
      "hireable-item": [templated],
      "one-off-event": [templated, hideType, noDaily],
      subscription: [templated, hideType, hideDate, noDaily],
      "weekly-event": [templated, hideType],
    });
  });

  test("seeds the hireable-item contact fields with phone for delivery contact", () => {
    expectIncludesAll(newPageFor("hireable-item"), [
      'name="fields" value="email" checked',
      'name="fields" value="phone" checked',
      'name="fields" value="address" checked',
    ]);
  });

  const WEEK = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const tickedDays = (templateId: string): string[] => {
    const html = newPageFor(templateId);
    return WEEK.filter((day) =>
      html.includes(`name="bookableDays" value="${day}" checked`),
    );
  };

  test("seeds every weekday into the hireable-item and day-pass bookable_days", () => {
    expect(tickedDays("hireable-item")).toEqual(WEEK);
    expect(tickedDays("day-pass")).toEqual(WEEK);
  });

  test("seeds one weekday into the weekly-event bookable_days", () => {
    expect(tickedDays("weekly-event")).toEqual(["Monday"]);
  });

  test("seeds the donation with pay more ticked and no check-in", () => {
    expectIncludesAll(newPageFor("donation"), [
      'name="canPayMore" value="1" checked',
      'name="purchaseOnly" value="1" checked',
    ]);
  });

  test("preserves selected groups on error re-render", () => {
    const groups = [testGroup({ id: 3, name: "Group Three" })];
    const html = adminListingNewPage(groups, OWNER_SESSION, {
      selectedGroupIds: [3],
    });
    expectIncludesAll(html, ['value="3"', "checked"]);
  });

  test("carries custom sentinel through as template_id hidden input", () => {
    expectIncludesAll(newPageFor("custom"), [
      'name="templateId"',
      'value="custom"',
    ]);
  });

  test("carries the duplicatedFrom hidden input when the rejected create posted it", () => {
    const html = adminListingNewPage([], OWNER_SESSION, {
      values: { duplicatedFrom: "42" },
    });
    expectIncludesAll(html, ['name="duplicatedFrom" type="hidden" value="42"']);
  });

  test("does not render the duplicatedFrom input when not in submitted values", () => {
    const html = adminListingNewPage([], OWNER_SESSION, { values: {} });
    assert(!html.includes('name="duplicatedFrom"'));
  });

  test("keeps the use-defaults tick when the rejected create posted it", () => {
    settings.setForTest({ listing_defaults: '{"hidden":true}' });
    try {
      const ticked = adminListingNewPage([], OWNER_SESSION, {
        values: { useDefaults: "1" },
      });
      const unticked = adminListingNewPage([], OWNER_SESSION, { values: {} });
      expect(ticked).toMatch(/checked[^>]*id="use-defaults"/);
      expect(unticked).not.toMatch(/checked[^>]*id="use-defaults"/);
      assertStringIncludes(unticked, 'id="use-defaults"');
    } finally {
      settings.clearTestOverride("listing_defaults");
    }
  });
});

describe("adminListingPage edit form pre-fills date and location", () => {
  registerListingTemplateHooks();

  test("empty date shows no pre-filled value in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendeeCount: 0, date: "" }),
    );
    // The date field should render split date and time inputs
    expectIncludesAll(html, ['name="dateDate"', 'name="dateTime"']);
  });

  test("non-empty date shows formatted split values in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({
        attendeeCount: 0,
        date: "2026-06-15T14:00:00.000Z",
      }),
    );
    // Should contain split date and time values converted to Europe/London (BST = UTC+1)
    expectIncludesAll(html, ['value="2026-06-15"', 'value="15:00"']);
  });

  test("pre-fills location in edit form", () => {
    const html = editPanelHtml(
      testListingWithCount({ attendeeCount: 0, location: "Village Hall" }),
    );
    assertStringIncludes(html, 'value="Village Hall"');
  });
});

describe("adminListingEditPage max_price field", () => {
  registerListingTemplateHooks();

  // A can_pay_more listing rendered on the edit form for the given max_price.
  const maxPriceEditHtml = (maxPrice: number) =>
    editPanelHtml(
      testListingWithCount({
        attendeeCount: 0,
        canPayMore: true,
        maxPrice,
      }),
    );

  test("renders max_price field with value when set", () => {
    const html = maxPriceEditHtml(50000);
    expectIncludesAll(html, ['name="maxPrice"', 'value="500.00"']);
  });

  test("renders max_price field with 0.00 when zero", () => {
    const html = maxPriceEditHtml(0);
    expectIncludesAll(html, ['name="maxPrice"', 'value="0.00"']);
  });
});
