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
  installFakeDom,
  quantitySpec as quantity,
  restoreDocument,
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
});
