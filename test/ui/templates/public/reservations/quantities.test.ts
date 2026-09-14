import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  monthLabelsForListing,
  quantityOptions,
  restoredChildQty,
  restoredPackageQuantity,
  restoredQuantity,
} from "#templates/public/reservations/quantities.ts";
import { withSubmittedValues } from "#test-utils/saved-form.ts";

describe("monthLabelsForListing", () => {
  test("names the months each count buys on a plan", () => {
    const labels = monthLabelsForListing({
      assign_built_site: true,
      initial_site_months: 3,
      months_per_unit: 0,
    });
    expect(labels?.(1)).toBe("3 months");
    expect(labels?.(2)).toBe("6 months");
  });

  test("prices a renewal page's counts by months per unit", () => {
    // A real renewal tier: purchase-only, hidden, priced by months per unit.
    expect(
      monthLabelsForListing(
        {
          assign_built_site: false,
          initial_site_months: 0,
          months_per_unit: 1,
        },
        true,
      )?.(2),
    ).toBe("2 months");
    // Every renewal tier prices by its months per unit, plan or not.
    expect(
      monthLabelsForListing(
        {
          assign_built_site: false,
          initial_site_months: 0,
          months_per_unit: 2,
        },
        true,
      )?.(3),
    ).toBe("6 months");
  });

  test("keeps the plain count on a renewal page for a non-tier listing", () => {
    // A renewal page only offers qualifying tiers, so a listing that prices
    // no months per unit never reaches one; outside a renewal its units stay
    // plain tickets.
    expect(
      monthLabelsForListing(
        {
          assign_built_site: false,
          initial_site_months: 0,
          months_per_unit: 0,
        },
        true,
      ),
    ).toBeUndefined();
  });

  test("leaves ordinary listings to the plain count", () => {
    expect(
      monthLabelsForListing({
        assign_built_site: false,
        initial_site_months: 0,
        months_per_unit: 0,
      }),
    ).toBeUndefined();
  });

  test("a retired plan keeps the plain count", () => {
    // Disabling site assignment retains the stored month term; the count is
    // plain tickets again from the moment the flag is off.
    expect(
      monthLabelsForListing({
        assign_built_site: false,
        initial_site_months: 3,
        months_per_unit: 0,
      }),
    ).toBeUndefined();
  });

  test("a one-month renewal tier still prices its counts in months", () => {
    expect(
      monthLabelsForListing(
        {
          assign_built_site: false,
          initial_site_months: 0,
          months_per_unit: 1,
        },
        true,
      )?.(4),
    ).toBe("4 months");
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
      withSubmittedValues({ quantity_1: "5" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(5);
  });

  test("clamps a too-large submitted count", () => {
    expect(
      withSubmittedValues({ quantity_1: "30" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(10);
  });

  test("keeps zero for a non-numeric submitted count", () => {
    expect(
      withSubmittedValues({ quantity_1: "abc" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(0);
  });

  test("keeps zero for a hex-looking submitted count", () => {
    expect(
      withSubmittedValues({ quantity_1: "0x10" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(0);
  });

  test("clamps a negative submitted count to zero", () => {
    expect(
      withSubmittedValues({ quantity_1: "-3" }, () =>
        restoredQuantity(1, undefined, 10),
      ),
    ).toBe(0);
  });
});

describe("restoredChildQty", () => {
  test("stays at zero when nothing was submitted", () => {
    expect(restoredChildQty(7, 10, 5)).toBe(0);
  });

  test("restores a submitted child count, clamped high", () => {
    expect(
      withSubmittedValues({ child_qty_7_10: "3" }, () =>
        restoredChildQty(7, 10, 2),
      ),
    ).toBe(2);
  });
});
