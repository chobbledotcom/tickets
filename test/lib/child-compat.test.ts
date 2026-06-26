import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initChildCompat } from "#src/ui/client/admin/child-compat.ts";
import { initChildRequired } from "#src/ui/client/admin/child-required.ts";
import {
  childPriceSpec as childPrice,
  childQtySpec as childQty,
  childSelectorSpec as childSelector,
  dateSpec as date,
  dayCountSpec as dayCount,
  type FakeElement,
  hiddenQuantitySpec as hiddenQuantity,
  installFakeDom,
  quantitySpec as quantity,
  restoreDocument,
  soleChildSpec as soleChild,
} from "#test-utils/fake-dom.ts";

const byName = (roots: FakeElement[], name: string): FakeElement =>
  roots.find((root) => root.attrs.get("name") === name)!;

describe("child date/span compatibility", () => {
  afterEach(restoreDocument);

  test("does nothing when there is no child selector on the page", () => {
    installFakeDom([date("2026-06-01"), quantity("101", "1")]);
    expect(() => initChildCompat()).not.toThrow();
  });

  test("disables and zeroes a child the selected date can't serve, keeping a compatible sibling enabled", () => {
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "2"),
      childSelector("101"),
      // Child A serves the selected date; child B serves only an earlier date.
      childQty("101", "202", "1", false, {
        dates: ["2026-06-01", "2026-06-08"],
      }),
      childQty("101", "303", "1", false, { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
    expect(byName(roots, "child_qty_101_202").value).toBe("1");
    // The incompatible child is disabled and its chosen quantity zeroed.
    expect(byName(roots, "child_qty_101_303").disabled).toBe(true);
    expect(byName(roots, "child_qty_101_303").value).toBe("0");
  });

  test("disables a child the selected day-count can't serve", () => {
    const roots = installFakeDom([
      dayCount("3"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, { spans: [1, 3] }),
      childQty("101", "303", "1", false, { spans: [1] }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
    expect(byName(roots, "child_qty_101_303").disabled).toBe(true);
    expect(byName(roots, "child_qty_101_303").value).toBe("0");
  });

  test("re-enables a child when the buyer switches to a date both children support", () => {
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "2"),
      childSelector("101"),
      childQty("101", "202", "1", false, {
        dates: ["2026-06-01", "2026-06-08"],
      }),
      childQty("101", "303", "1", false, { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();
    expect(byName(roots, "child_qty_101_303").disabled).toBe(true);

    // Switch to a date both children serve; the previously-disabled child returns.
    byName(roots, "date").value = "2026-06-01";
    byName(roots, "date").dispatch("change");

    expect(byName(roots, "child_qty_101_303").disabled).toBe(false);
  });

  test("never re-enables a server-disabled (sold-out) child", () => {
    const roots = installFakeDom([
      date("2026-06-01"),
      quantity("101", "1"),
      childSelector("101"),
      // Sold-out child: server-rendered disabled, no data-child-qty marker.
      childQty("101", "202", "0", true),
    ]);

    initChildCompat();
    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);

    // A compatible selection must not flip the sold-out child back on.
    byName(roots, "date").value = "2026-06-08";
    byName(roots, "date").dispatch("change");

    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);
  });

  test("zeroing an incompatible child notifies dependents so its price stops being required (Fix 2)", () => {
    // A pay-more child chosen (qty 1) under an in-cart parent: child-required has
    // marked its price input `required`. When a date change disables+zeroes the
    // child, child-compat must fire a `change` so child-required re-runs and
    // drops the `required` flag — otherwise the hidden child's price input would
    // block submission.
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, { dates: ["2026-06-01"] }),
      childPrice("101", "202"),
    ]);
    const price = byName(roots, "child_price_101_202");

    initChildRequired();
    // The chosen child's price input starts out required (inline feedback).
    expect(price.required).toBe(true);

    initChildCompat();

    // The selected date can't be served by the child, so it is disabled+zeroed
    // and child-required re-runs: the dropped child's price is no longer required.
    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);
    expect(byName(roots, "child_qty_101_202").value).toBe("0");
    expect(price.required).toBe(false);
  });

  test("does not notify dependents when an already-zero incompatible child is disabled (Fix 2)", () => {
    // An incompatible child whose quantity is already 0 must NOT fire a redundant
    // `change` (nothing was cleared), so a dependent listener stays unfired.
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "0", false, { dates: ["2026-06-01"] }),
    ]);
    let fired = false;
    byName(roots, "child_qty_101_202").addEventListener("change", () => {
      fired = true;
    });

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);
    expect(fired).toBe(false);
  });

  test("a child with no date/span constraint stays enabled for any selection", () => {
    const roots = installFakeDom([
      date("2026-06-01"),
      dayCount("2"),
      quantity("101", "1"),
      childSelector("101"),
      // A standard child emits neither attribute (always compatible).
      childQty("101", "202", "1", false, {}),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
    expect(byName(roots, "child_qty_101_202").value).toBe("1");
  });

  test("picks the date set matching the selected day-count for a customisable parent (Fix 4)", () => {
    // A daily child under a customisable parent serves a different set of start
    // dates per span: it can start 2026-06-08 for a 1-day span but only
    // 2026-06-09 for a 2-day span. With day_count=2 chosen, selecting 2026-06-08
    // (valid for a 1-day span but NOT a 2-day span) must disable the child; a
    // span/date it can serve (day_count=1, 2026-06-08) keeps it enabled.
    const roots = installFakeDom([
      date("2026-06-08"),
      dayCount("2"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, {
        dates: { "1": ["2026-06-08", "2026-06-09"], "2": ["2026-06-09"] },
        spans: [1, 2],
      }),
    ]);

    initChildCompat();
    // day_count=2 + 2026-06-08: the 2-day span can't start that day → disabled.
    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);
    expect(byName(roots, "child_qty_101_202").value).toBe("0");

    // Switch to a 1-day span: 2026-06-08 is a valid 1-day start → re-enabled.
    byName(roots, "child_qty_101_202").value = "1";
    byName(roots, "day_count").value = "1";
    byName(roots, "day_count").dispatch("change");
    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
  });

  test("flags and disables the parent when a sole child can't serve the selection (Fix 1)", () => {
    // A sole auto-selected child has no quantity control, so its incompatibility
    // is surfaced on the PARENT: when the selected date can't be served the
    // parent's quantity is disabled+zeroed and the sole block flagged, rather
    // than showing "Includes …" and failing at submit.
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "2"),
      childSelector("101"),
      soleChild("101", "202", { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();

    expect(byName(roots, "quantity_101").disabled).toBe(true);
    expect(byName(roots, "quantity_101").value).toBe("0");
    const sole = roots.find((r) => r.dataset.soleParent === "101")!;
    expect(sole.getAttribute("data-sole-incompatible")).toBe("");
  });

  test("re-enables the parent and clears the flag when the sole child can serve the selection (Fix 1)", () => {
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "2"),
      childSelector("101"),
      soleChild("101", "202", { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();
    expect(byName(roots, "quantity_101").disabled).toBe(true);

    // Switch to a date the sole child serves: parent re-enabled, flag cleared.
    byName(roots, "date").value = "2026-06-01";
    byName(roots, "date").dispatch("change");

    expect(byName(roots, "quantity_101").disabled).toBe(false);
    const sole = roots.find((r) => r.dataset.soleParent === "101")!;
    expect(sole.getAttribute("data-sole-incompatible")).toBe(null);
  });

  test("restores an auto-hidden sole-child parent quantity to 1 when the selection becomes compatible (Fix 5)", () => {
    // A single-parent sole-child page auto-hides the parent quantity as a hidden
    // value="1" input. An incompatible date disables+zeroes it; switching back to
    // a compatible date must restore it to "1" — otherwise it re-enables at "0"
    // with no visible control and the form submits no parent ticket.
    const roots = installFakeDom([
      date("2026-06-08"),
      hiddenQuantity("101"),
      childSelector("101"),
      soleChild("101", "202", { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();
    // Incompatible date: the hidden parent quantity is disabled and zeroed.
    expect(byName(roots, "quantity_101").disabled).toBe(true);
    expect(byName(roots, "quantity_101").value).toBe("0");

    // Switch to a date the sole child serves: parent re-enabled AND restored to 1.
    byName(roots, "date").value = "2026-06-01";
    byName(roots, "date").dispatch("change");

    expect(byName(roots, "quantity_101").disabled).toBe(false);
    expect(byName(roots, "quantity_101").value).toBe("1");
  });

  test("does not clobber a visible sole-child parent quantity when the selection becomes compatible (Fix 5)", () => {
    // A visible quantity select that was zeroed when incompatible stays at the
    // buyer's re-pickable "0" on re-enable (only the hidden auto-quantity, which
    // the buyer can't re-pick, is restored).
    const roots = installFakeDom([
      date("2026-06-08"),
      quantity("101", "2"),
      childSelector("101"),
      soleChild("101", "202", { dates: ["2026-06-01"] }),
    ]);

    initChildCompat();
    expect(byName(roots, "quantity_101").value).toBe("0");

    byName(roots, "date").value = "2026-06-01";
    byName(roots, "date").dispatch("change");

    expect(byName(roots, "quantity_101").disabled).toBe(false);
    expect(byName(roots, "quantity_101").value).toBe("0");
  });

  test("leaves a date/span-constrained child enabled until a date and day-count are chosen", () => {
    const roots = installFakeDom([
      date(""),
      dayCount(""),
      quantity("101", "1"),
      childSelector("101"),
      // A daily customisable child constrained on BOTH dimensions; with neither
      // the date nor the day-count chosen yet, there is nothing to reject.
      childQty("101", "202", "1", false, {
        dates: ["2026-06-08"],
        spans: [3],
      }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
  });

  test("disables a child whose selected span serves no date (empty per-span set) (Fix 4)", () => {
    // The child serves the 8th for a 1-day span, but its 2-day span serves no
    // date at all (encoded `2:`); with day_count=2 chosen it can't be booked.
    const roots = installFakeDom([
      date("2026-06-08"),
      dayCount("2"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, {
        dates: { "1": ["2026-06-08"], "2": [] },
      }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(true);
    expect(byName(roots, "child_qty_101_202").value).toBe("0");
  });

  test("leaves a child enabled when the selected day-count has no date entry (Fix 4)", () => {
    // The child only declares dates for a 1-day span; with day_count=3 (no entry)
    // the date constraint can't be applied, so it stays enabled and the fold
    // decides at submit.
    const roots = installFakeDom([
      date("2026-06-08"),
      dayCount("3"),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, { dates: { "1": ["2026-06-01"] } }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
    expect(byName(roots, "child_qty_101_202").value).toBe("1");
  });

  test("leaves a multi-span child enabled until a day-count is chosen (Fix 4)", () => {
    // Two span entries but no day-count chosen yet: the applicable date set is
    // ambiguous, so the date constraint is left un-applied (enabled).
    const roots = installFakeDom([
      date("2026-06-08"),
      dayCount(""),
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", false, {
        dates: { "1": ["2026-06-01"], "2": ["2026-06-02"] },
      }),
    ]);

    initChildCompat();

    expect(byName(roots, "child_qty_101_202").disabled).toBe(false);
  });

  test("flags an incompatible sole child even when the parent has no quantity control (Fix 1)", () => {
    // A hidden-quantity page has no `quantity_<parent>` control, so an
    // incompatible sole child only flags its marker (nothing to disable).
    const roots = installFakeDom([
      date("2026-06-08"),
      childSelector("101"),
      soleChild("101", "202", { dates: ["2026-06-01"] }),
    ]);

    expect(() => initChildCompat()).not.toThrow();
    const sole = roots.find((r) => r.dataset.soleParent === "101")!;
    expect(sole.getAttribute("data-sole-incompatible")).toBe("");
  });
});
