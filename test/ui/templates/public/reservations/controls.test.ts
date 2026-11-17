import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  renderDateSelector,
  renderDayCountSelector,
  renderPayMoreInput,
  renderTermsAndCheckbox,
} from "#templates/public/reservations/controls.ts";
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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
    expectExcludesAll(html, ['value="2026-01-01" onload="alert(1)"']);
  });

  test("marks the selected date as selected", () => {
    const html = renderDateSelector(
      ["2026-01-01", "2026-01-02"],
      "2026-01-02",
      1,
    );
    expectIncludesAll(html, [
      'value="2026-01-02" selected',
      'value="2026-01-01"',
    ]);
    // The unselected date stays unmarked; no filler sits between options.
    expectExcludesAll(html, ['value="2026-01-01" selected', "mutated"]);
  });

  test("says how many days each booking reserves when it spans several", () => {
    const html = renderDateSelector(["2026-01-01"], "", 3);
    assertStringIncludes(html, reservesHint(3));
  });

  test("says nothing about duration for one-day bookings", () => {
    const html = renderDateSelector(["2026-01-01"], "", 1);
    // The duration slot stays empty, so no length note and no filler render.
    expectExcludesAll(html, [reservesHintStart(), "mutated"]);
  });

  test("offers the error copy when no dates remain", () => {
    expect(renderDateSelector([], "", 1)).toBe(
      '<div class="error">No dates are currently available for booking.</div>',
    );
  });
});

describe("renderDayCountSelector", () => {
  test("restores the submitted day count on a re-render", async () => {
    const html = await withSubmittedValues({ dayCount: "2" }, () =>
      renderDayCountSelector([1, 2, 3]),
    );
    assertStringIncludes(html, '<option value="2" selected>');
    // Unselected options keep their chosen-state slot empty.
    expectExcludesAll(html, [
      '<option value="1" selected>',
      '<option value="3" selected>',
      "mutated",
    ]);
  });

  test("marks no day count when nothing was submitted", () => {
    const html = renderDayCountSelector([1, 2]);
    assertStringIncludes(html, '<option value="1">');
    // A span without a stated price renders no price suffix.
    expectExcludesAll(html, ['value="1" selected', "mutated"]);
  });

  test("offers the error copy when no booking lengths remain", () => {
    expect(renderDayCountSelector([])).toBe(
      '<div class="error">No booking lengths are currently available.</div>',
    );
  });
});

describe("renderPayMoreInput", () => {
  const listing = {
    assignBuiltSite: false,
    initialSiteMonths: 0,
    maxPrice: 10000,
    unitPrice: 500,
  };
  const paidSitePlan = {
    ...listing,
    assignBuiltSite: true,
    initialSiteMonths: 3,
  };
  const freeSitePlan = { ...paidSitePlan, unitPrice: 0 };
  const freeTicket = { ...listing, unitPrice: 0 };

  /** Assert the price wording `plan` renders, and that it never carries the
   *  wording of the other pricing shape. */
  const expectPriceWording = (
    plan: typeof listing,
    wording: string,
    absent: readonly string[],
  ): void => {
    const html = renderPayMoreInput(plan);
    assertStringIncludes(html, wording);
    expectExcludesAll(html, absent);
  };

  test("restores the submitted price on a re-render", async () => {
    const html = await withSubmittedValues({ customPrice: "25.00" }, () =>
      renderPayMoreInput(listing),
    );
    assertStringIncludes(html, 'value="25.00"');
  });

  test("falls back to the minimum price when nothing was submitted", () => {
    assertStringIncludes(renderPayMoreInput(listing), 'value="5.00"');
  });

  test("states the months each priced unit buys on a site plan", () => {
    expectPriceWording(paidSitePlan, "Price per 3 months (£5 minimum)", [
      "Price per ticket",
    ]);
  });

  test("prices an ordinary listing per ticket", () => {
    const html = renderPayMoreInput(listing);
    assertStringIncludes(html, "Price per ticket (£5 minimum)");
  });

  test("names the optional ceiling in months on a free site plan", () => {
    expectPriceWording(
      freeSitePlan,
      "Price per 3 months (optional, up to £100)",
      ["required"],
    );
  });

  test("per ticket stays the wording on an optional ordinary listing", () => {
    expectPriceWording(freeTicket, "Price per ticket (optional, up to £100)", [
      "required",
    ]);
  });

  test("makes a page-listing price input required down to the smallest price", () => {
    const nearlyFree = { ...listing, unitPrice: 50 };
    assertStringIncludes(renderPayMoreInput(nearlyFree), " required />");
  });

  test("treats even one minor unit as a priced minimum", () => {
    const smallest = { ...listing, unitPrice: 1 };
    const html = renderPayMoreInput(smallest);
    expectIncludesAll(html, [
      "Price per ticket (£0.01 minimum)",
      " required />",
    ]);
  });

  test("prefills the entered value when it is at or above the minimum", () => {
    assertStringIncludes(
      renderPayMoreInput(listing, "customPrice", 2500),
      'value="25.00"',
    );
    // Below the minimum the buyer cannot start lower than it.
    assertStringIncludes(
      renderPayMoreInput(listing, "customPrice", 100),
      'value="5.00"',
    );
  });

  test("keeps a child's price input optional", () => {
    const html = renderPayMoreInput(
      listing,
      "childPrice7_10",
      undefined,
      false,
    );
    expectExcludesAll(html, ["required", "mutated"]);
  });
});

describe("renderTermsAndCheckbox", () => {
  test("keeps the box ticked when the buyer had agreed", async () => {
    const html = await withSubmittedValues({ agreeTerms: "1" }, () =>
      renderTermsAndCheckbox("Be kind."),
    );
    assertStringIncludes(html, 'name="agreeTerms" value="1" checked required');
  });

  test("starts with the box clear", () => {
    const html = renderTermsAndCheckbox("Be kind.");
    assertStringIncludes(html, 'name="agreeTerms" value="1" required');
    expectExcludesAll(html, ["checked"]);
  });
});
