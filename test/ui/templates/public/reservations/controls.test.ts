import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderDateSelector } from "#templates/public/reservations/controls.ts";

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
    expect(html).toContain("each booking reserves 3 days");
  });

  test("says nothing about duration for one-day bookings", () => {
    const html = renderDateSelector(["2026-01-01"], "", 1);
    expect(html).not.toContain("each booking reserves");
  });
});
