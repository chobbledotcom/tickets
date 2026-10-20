import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  renderDateSelector,
  renderDayCountSelector,
  renderPayMoreInput,
  renderTermsAndCheckbox,
} from "#templates/public/reservations/controls.ts";
import { reservesHint, reservesHintStart } from "#test-utils/duration-hint.ts";
import { withSubmittedValues } from "#test-utils/saved-form.ts";

describe("renderDateSelector", () => {
  test("escapes date values in the option value attribute", () => {
    // A date string containing a double-quote would break out of the value
    // attribute and inject markup if not escaped.
    const html = renderDateSelector(
      ['2026-01-01" onload="alert(1)', "2026-01-02"],
      "",
      1,
    );
    assertStringIncludes(
      html,
      'value="2026-01-01&quot; onload=&quot;alert(1)"',
    );
    assert(!html.includes('value="2026-01-01" onload="alert(1)"'));
  });

  test("marks the selected date as selected", () => {
    const html = renderDateSelector(
      ["2026-01-01", "2026-01-02"],
      "2026-01-02",
      1,
    );
    assertStringIncludes(html, 'value="2026-01-02" selected');
    assertStringIncludes(html, 'value="2026-01-01"');
    assert(!html.includes('value="2026-01-01" selected'));
    // Options join edge to edge between the two dates.
    assert(!html.includes("mutated"));
  });

  test("says how many days each booking reserves when it spans several", () => {
    const html = renderDateSelector(["2026-01-01"], "", 3);
    assertStringIncludes(html, reservesHint(3));
  });

  test("says nothing about duration for one-day bookings", () => {
    const html = renderDateSelector(["2026-01-01"], "", 1);
    assert(!html.includes(reservesHintStart()));
    // The duration slot stays empty; no stray filler renders between options.
    assert(!html.includes("mutated"));
  });

  test("offers the error copy when no dates remain", () => {
    expect(renderDateSelector([], "", 1)).toBe(
      '<div class="error">No dates are currently available for booking.</div>',
    );
  });
});

describe("renderDayCountSelector", () => {
  test("restores the submitted day count on a re-render", async () => {
    const html = await withSubmittedValues({ day_count: "2" }, () =>
      renderDayCountSelector([1, 2, 3]),
    );
    assertStringIncludes(html, '<option value="2" selected>');
    assert(!html.includes('<option value="1" selected>'));
    assert(!html.includes('<option value="3" selected>'));
    // Unselected options keep their chosen-state slot empty.
    assert(!html.includes("mutated"));
  });

  test("marks no day count when nothing was submitted", () => {
    const html = renderDayCountSelector([1, 2]);
    assertStringIncludes(html, '<option value="1">');
    assert(!html.includes('value="1" selected'));
    // A span without a stated price renders no price suffix.
    assert(!html.includes("mutated"));
  });

  test("offers the error copy when no booking lengths remain", () => {
    expect(renderDayCountSelector([])).toBe(
      '<div class="error">No booking lengths are currently available.</div>',
    );
  });
});

describe("renderPayMoreInput", () => {
  const listing = {
    assign_built_site: false,
    initial_site_months: 0,
    max_price: 10000,
    unit_price: 500,
  };

  test("restores the submitted price on a re-render", async () => {
    const html = await withSubmittedValues({ custom_price: "25.00" }, () =>
      renderPayMoreInput(listing),
    );
    assertStringIncludes(html, 'value="25.00"');
  });

  test("falls back to the minimum price when nothing was submitted", () => {
    assertStringIncludes(renderPayMoreInput(listing), 'value="5.00"');
  });

  test("states the months each priced unit buys on a site plan", () => {
    const plan = {
      assign_built_site: true,
      initial_site_months: 3,
      max_price: 10000,
      unit_price: 500,
    };
    const html = renderPayMoreInput(plan);
    assertStringIncludes(html, "Price per 3 months (£5 minimum)");
    assert(!html.includes("Price per ticket"));
  });

  test("prices an ordinary listing per ticket", () => {
    const html = renderPayMoreInput(listing);
    assertStringIncludes(html, "Price per ticket (£5 minimum)");
  });

  test("names the optional ceiling in months on a free site plan", () => {
    const freePlan = {
      assign_built_site: true,
      initial_site_months: 3,
      max_price: 10000,
      unit_price: 0,
    };
    const html = renderPayMoreInput(freePlan);
    assertStringIncludes(html, "Price per 3 months (optional, up to £100)");
    assert(!html.includes("required"));
  });

  test("per ticket stays the wording on an optional ordinary listing", () => {
    const free = { ...listing, unit_price: 0 };
    const html = renderPayMoreInput(free);
    assertStringIncludes(html, "Price per ticket (optional, up to £100)");
  });

  test("makes a page-listing price input required down to the smallest price", () => {
    const nearlyFree = { ...listing, unit_price: 50 };
    assertStringIncludes(renderPayMoreInput(nearlyFree), " required />");
  });

  test("treats even one minor unit as a priced minimum", () => {
    const smallest = { ...listing, unit_price: 1 };
    const html = renderPayMoreInput(smallest);
    assertStringIncludes(html, "Price per ticket (£0.01 minimum)");
    assertStringIncludes(html, " required />");
  });

  test("prefills the entered value when it is at or above the minimum", () => {
    assertStringIncludes(
      renderPayMoreInput(listing, "custom_price", 2500),
      'value="25.00"',
    );
    // Below the minimum the buyer cannot start lower than it.
    assertStringIncludes(
      renderPayMoreInput(listing, "custom_price", 100),
      'value="5.00"',
    );
  });

  test("keeps a child's price input optional", () => {
    const html = renderPayMoreInput(
      listing,
      "child_price_7_10",
      undefined,
      false,
    );
    assert(!html.includes("required"));
    assert(!html.includes("mutated"));
  });
});

describe("renderTermsAndCheckbox", () => {
  test("keeps the box ticked when the buyer had agreed", async () => {
    const html = await withSubmittedValues({ agree_terms: "1" }, () =>
      renderTermsAndCheckbox("Be kind."),
    );
    assertStringIncludes(html, 'name="agree_terms" value="1" checked required');
  });

  test("starts with the box clear", () => {
    const html = renderTermsAndCheckbox("Be kind.");
    assertStringIncludes(html, 'name="agree_terms" value="1" required');
    assert(!html.includes("checked"));
  });
});
