import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import {
  monthLabelsForListing,
  quantityOptions,
  restoredChildQty,
  restoredPackageQuantity,
  restoredQuantity,
} from "#templates/public/reservations/quantities.ts";

/** Read restores under the just-submitted values a re-render sees. */
const withSaved = (saved: Record<string, string>, read: () => number): number =>
  runWithSavedFormContext(() => {
    setSavedFormData(new FormParams(saved));
    return read();
  });

describe("monthLabelsForListing", () => {
  test("names the months each count buys on a plan", () => {
    const labels = monthLabelsForListing({
      assign_built_site: true,
      initial_site_months: 3,
    });
    expect(labels?.(1)).toBe("3 months");
    expect(labels?.(2)).toBe("6 months");
  });

  test("leaves ordinary listings to the plain count", () => {
    expect(
      monthLabelsForListing({
        assign_built_site: false,
        initial_site_months: 0,
      }),
    ).toBeUndefined();
  });
});

describe("quantityOptions", () => {
  test("lists zero through max with the chosen count selected", () => {
    expect(quantityOptions(2, 1)).toBe(
      '<option value="0">0</option><option value="1" selected>1</option><option value="2">2</option>',
    );
  });

  test("labels each option with the count the caller states", () => {
    const months = (count: number): string =>
      count === 1 ? "1 month" : `${count} months`;
    expect(quantityOptions(2, 0, months)).toBe(
      '<option value="0" selected>0 months</option><option value="1">1 month</option><option value="2">2 months</option>',
    );
  });
});

describe("restoredPackageQuantity", () => {
  test("offers one package while some room is left", () => {
    expect(restoredPackageQuantity(7, 5)).toBe(1);
  });

  test("stays at zero when nothing can be ordered", () => {
    expect(restoredPackageQuantity(7, 0)).toBe(0);
  });
});

describe("restoredQuantity", () => {
  test("restores the pre-filled quantity, clamped to the available range", () => {
    expect(restoredQuantity(1, { quantity: 3 }, 10)).toBe(3);
    expect(restoredQuantity(1, { quantity: 30 }, 10)).toBe(10);
  });

  test("stays at zero without a pre-fill", () => {
    expect(restoredQuantity(1, undefined, 10)).toBe(0);
  });

  test("stays at zero for a negative pre-fill", () => {
    expect(restoredQuantity(1, { quantity: -3 }, 10)).toBe(0);
  });

  test("restores the just-submitted count", () => {
    expect(
      withSaved({ quantity_1: "5" }, () => restoredQuantity(1, undefined, 10)),
    ).toBe(5);
  });

  test("clamps a too-large submitted count", () => {
    expect(
      withSaved({ quantity_1: "30" }, () => restoredQuantity(1, undefined, 10)),
    ).toBe(10);
  });

  test("keeps zero for a non-numeric submitted count", () => {
    expect(
      withSaved({ quantity_1: "abc" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(0);
  });

  test("keeps zero for a hex-looking submitted count", () => {
    expect(
      withSaved({ quantity_1: "0x10" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(0);
  });

  test("clamps a negative submitted count to zero", () => {
    expect(
      withSaved({ quantity_1: "-3" }, () => restoredQuantity(1, undefined, 10)),
    ).toBe(0);
  });
});

describe("restoredChildQty", () => {
  test("stays at zero when nothing was submitted", () => {
    expect(restoredChildQty(7, 10, 5)).toBe(0);
  });

  test("restores a submitted child count, clamped high", () => {
    expect(
      withSaved({ child_qty_7_10: "3" }, () => restoredChildQty(7, 10, 2)),
    ).toBe(2);
  });
});
