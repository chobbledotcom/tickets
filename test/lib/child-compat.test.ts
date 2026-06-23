import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initChildCompat } from "#src/ui/client/admin/child-compat.ts";
import {
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
