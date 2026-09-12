import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import {
  renderDateSelector,
  renderDayCountSelector,
  renderPayMoreInput,
  renderTermsAndCheckbox,
} from "#templates/public/reservations/controls.ts";
import { reservesHint, reservesHintStart } from "#test-utils/duration-hint.ts";

/** Render with the given just-submitted values stashed, the way a validation
 *  re-render sees them. */
const renderedWithSaved = (
  saved: Record<string, string>,
  render: () => string,
): string =>
  runWithSavedFormContext(() => {
    setSavedFormData(new FormParams(saved));
    return render();
  });

describe("renderDateSelector", () => {
  test("escapes date values in the option value attribute", () => {
    // A date string containing a double-quote would break out of the value
    // attribute and inject markup if not escaped.
    const html = renderDateSelector([
      '2026-01-01" onload="alert(1)',
      "2026-01-02",
    ]);
    expect(html).toContain('value="2026-01-01&quot; onload=&quot;alert(1)"');
    expect(html).not.toContain('value="2026-01-01" onload="alert(1)"');
  });

  test("marks the selected date as selected", () => {
    const html = renderDateSelector(["2026-01-01", "2026-01-02"], "2026-01-02");
    expect(html).toContain('value="2026-01-02" selected');
    expect(html).toContain('value="2026-01-01"');
    expect(html).not.toContain('value="2026-01-01" selected');
    // Options join edge to edge between the two dates.
    expect(html).not.toContain("mutated");
  });

  test("says how many days each booking reserves when it spans several", () => {
    const html = renderDateSelector(["2026-01-01"], "", 3);
    expect(html).toContain(reservesHint(3));
  });

  test("says nothing about duration for one-day bookings", () => {
    const html = renderDateSelector(["2026-01-01"]);
    expect(html).not.toContain(reservesHintStart());
    // The duration slot stays empty; no stray filler renders between options.
    expect(html).not.toContain("mutated");
  });

  test("offers the error copy when no dates remain", () => {
    expect(renderDateSelector([])).toBe(
      '<div class="error">No dates are currently available for booking.</div>',
    );
  });
});

describe("renderDayCountSelector", () => {
  test("restores the submitted day count on a re-render", () => {
    const html = renderedWithSaved({ day_count: "2" }, () =>
      renderDayCountSelector([1, 2, 3]),
    );
    expect(html).toContain('<option value="2" selected>');
    expect(html).not.toContain('<option value="1" selected>');
    expect(html).not.toContain('<option value="3" selected>');
    // Unselected options keep their chosen-state slot empty.
    expect(html).not.toContain("mutated");
  });

  test("marks no day count when nothing was submitted", () => {
    const html = renderDayCountSelector([1, 2]);
    expect(html).toContain('<option value="1">');
    expect(html).not.toContain('value="1" selected');
    // A span without a stated price renders no price suffix.
    expect(html).not.toContain("mutated");
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

  test("restores the submitted price on a re-render", () => {
    const html = renderedWithSaved({ custom_price: "25.00" }, () =>
      renderPayMoreInput(listing),
    );
    expect(html).toContain('value="25.00"');
  });

  test("falls back to the minimum price when nothing was submitted", () => {
    expect(renderPayMoreInput(listing)).toContain('value="5.00"');
  });

  test("states the months each priced unit buys on a site plan", () => {
    const plan = {
      assign_built_site: true,
      initial_site_months: 3,
      max_price: 10000,
      unit_price: 500,
    };
    const html = renderPayMoreInput(plan);
    expect(html).toContain("Price per 3 months (£5 minimum)");
    expect(html).not.toContain("Price per ticket");
  });

  test("prices an ordinary listing per ticket", () => {
    const html = renderPayMoreInput(listing);
    expect(html).toContain("Price per ticket (£5 minimum)");
  });

  test("names the optional ceiling in months on a free site plan", () => {
    const freePlan = {
      assign_built_site: true,
      initial_site_months: 3,
      max_price: 10000,
      unit_price: 0,
    };
    const html = renderPayMoreInput(freePlan);
    expect(html).toContain("Price per 3 months (optional, up to £100)");
    expect(html).not.toContain("required");
  });

  test("per ticket stays the wording on an optional ordinary listing", () => {
    const free = { ...listing, unit_price: 0 };
    const html = renderPayMoreInput(free);
    expect(html).toContain("Price per ticket (optional, up to £100)");
  });

  test("makes a page-listing price input required down to the smallest price", () => {
    const nearlyFree = { ...listing, unit_price: 50 };
    expect(renderPayMoreInput(nearlyFree)).toContain(" required />");
  });

  test("treats even one minor unit as a priced minimum", () => {
    const smallest = { ...listing, unit_price: 1 };
    const html = renderPayMoreInput(smallest);
    expect(html).toContain("Price per ticket (£0.01 minimum)");
    expect(html).toContain(" required />");
  });

  test("prefills the entered value when it is at or above the minimum", () => {
    expect(renderPayMoreInput(listing, "custom_price", 2500)).toContain(
      'value="25.00"',
    );
    // Below the minimum the buyer cannot start lower than it.
    expect(renderPayMoreInput(listing, "custom_price", 100)).toContain(
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
    expect(html).not.toContain("required");
    expect(html).not.toContain("mutated");
  });
});

describe("renderTermsAndCheckbox", () => {
  test("keeps the box ticked when the buyer had agreed", () => {
    const html = renderedWithSaved({ agree_terms: "1" }, () =>
      renderTermsAndCheckbox("Be kind."),
    );
    expect(html).toContain('name="agree_terms" value="1" checked required');
  });

  test("starts with the box clear", () => {
    const html = renderTermsAndCheckbox("Be kind.");
    expect(html).toContain('name="agree_terms" value="1" required');
    expect(html).not.toContain("checked");
  });
});
