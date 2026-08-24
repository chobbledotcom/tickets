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
  });

  test("says how many days each booking reserves when it spans several", () => {
    const html = renderDateSelector(["2026-01-01"], "", 3);
    expect(html).toContain(reservesHint(3));
  });

  test("says nothing about duration for one-day bookings", () => {
    const html = renderDateSelector(["2026-01-01"], "", 1);
    expect(html).not.toContain(reservesHintStart());
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
  });

  test("marks no day count when nothing was submitted", () => {
    const html = renderDayCountSelector([1, 2]);
    expect(html).toContain('<option value="1">');
    expect(html).not.toContain('value="1" selected');
  });
});

describe("renderPayMoreInput", () => {
  const listing = { max_price: 10000, unit_price: 500 };

  test("restores the submitted price on a re-render", () => {
    const html = renderedWithSaved({ custom_price: "25.00" }, () =>
      renderPayMoreInput(listing),
    );
    expect(html).toContain('value="25.00"');
  });

  test("falls back to the minimum price when nothing was submitted", () => {
    expect(renderPayMoreInput(listing)).toContain('value="5.00"');
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
