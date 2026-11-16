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
      assignBuiltSite: true,
      initialSiteMonths: 3,
      monthsPerUnit: 0,
    });
    expect(labels?.(1)).toBe("3 months");
    expect(labels?.(2)).toBe("6 months");
  });

  test("prices a renewal page's counts by months per unit", () => {
    // A real renewal tier: purchase-only, hidden, priced by months per unit.
    expect(
      monthLabelsForListing(
        {
          assignBuiltSite: false,
          initialSiteMonths: 0,
          monthsPerUnit: 1,
        },
        true,
      )?.(2),
    ).toBe("2 months");
    // Every renewal tier prices by its months per unit, plan or not.
    expect(
      monthLabelsForListing(
        {
          assignBuiltSite: false,
          initialSiteMonths: 0,
          monthsPerUnit: 2,
        },
        true,
      )?.(3),
    ).toBe("6 months");
  });

  /** A count of 0 to 2 as the selector shows it with this listing's labels. */
  const optionsFor = (
    listing: Parameters<typeof monthLabelsForListing>[0],
    renewal?: boolean,
  ): string => quantityOptions(2, 0, monthLabelsForListing(listing, renewal));
  const PLAIN_OPTIONS =
    '<option value="0" selected>0</option><option value="1">1</option><option value="2">2</option>';

  test("keeps the plain count on a renewal page for a non-tier listing", () => {
    // A renewal page only offers qualifying tiers, so a listing that prices
    // no months per unit never reaches one; outside a renewal its units stay
    // plain tickets.
    expect(
      optionsFor(
        { assignBuiltSite: false, initialSiteMonths: 0, monthsPerUnit: 0 },
        true,
      ),
    ).toBe(PLAIN_OPTIONS);
  });

  test("leaves ordinary listings to the plain count", () => {
    expect(
      optionsFor({
        assignBuiltSite: false,
        initialSiteMonths: 0,
        monthsPerUnit: 0,
      }),
    ).toBe(PLAIN_OPTIONS);
  });

  test("a retired plan keeps the plain count", () => {
    // Disabling site assignment retains the stored month term; the count is
    // plain tickets again from the moment the flag is off.
    expect(
      optionsFor({
        assignBuiltSite: false,
        initialSiteMonths: 3,
        monthsPerUnit: 0,
      }),
    ).toBe(PLAIN_OPTIONS);
  });

  test("a one-month renewal tier still prices its counts in months", () => {
    expect(
      monthLabelsForListing(
        {
          assignBuiltSite: false,
          initialSiteMonths: 0,
          monthsPerUnit: 1,
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

  test("offers the bundle minimum when no count was submitted", () => {
    // The select offers only the members' joint floor upward, so a fresh
    // page must open with the floor selected — a default of one would match
    // no emitted option and the browser would fall back to zero.
    expect(restoredPackageQuantity(7, 5, 3)).toBe(3);
    expect(restoredPackageQuantity(7, 0, 3)).toBe(0);
  });

  test("keeps an explicitly submitted count over the bundle minimum", async () => {
    await withSubmittedValues({ package_quantity_7: "4" }, () =>
      expect(restoredPackageQuantity(7, 5, 3)).toBe(4),
    );
  });

  test("keeps an explicitly submitted zero", async () => {
    await withSubmittedValues({ package_quantity_7: "0" }, () =>
      expect(restoredPackageQuantity(7, 5, 3)).toBe(0),
    );
  });

  test("snaps a stale count below the raised floor to zero", async () => {
    // The buyer submitted one before the owner raised the floor to three, so
    // the select no longer offers it — the re-render selects none rather
    // than a count the fold would refuse.
    await withSubmittedValues({ package_quantity_7: "1" }, () =>
      expect(restoredPackageQuantity(7, 5, 3)).toBe(0),
    );
  });
});

describe("restoredQuantity", () => {
  test("restores the pre-filled quantity, clamped to the available range", async () => {
    expect(restoredQuantity(1, { quantity: 3 }, 10, 1)).toBe(3);
    expect(restoredQuantity(1, { quantity: 30 }, 10, 1)).toBe(10);
  });

  test("stays at zero without a pre-fill", () => {
    expect(restoredQuantity(1, undefined, 10, 1)).toBe(0);
  });

  test("stays at zero for a negative pre-fill", () => {
    expect(restoredQuantity(1, { quantity: -3 }, 10, 1)).toBe(0);
  });

  test("restores the just-submitted count", async () => {
    expect(
      await withSubmittedValues({ quantity_1: "5" }, () =>
        restoredQuantity(1, undefined, 10, 1),
      ),
    ).toBe(5);
  });

  test("clamps a too-large submitted count", async () => {
    expect(
      await withSubmittedValues({ quantity_1: "30" }, () =>
        restoredQuantity(1, undefined, 10, 1),
      ),
    ).toBe(10);
  });

  test("keeps zero for a non-numeric submitted count", async () => {
    expect(
      await withSubmittedValues({ quantity_1: "abc" }, () =>
        restoredQuantity(1, undefined, 10, 1),
      ),
    ).toBe(0);
  });

  test("keeps zero for a hex-looking submitted count", async () => {
    expect(
      await withSubmittedValues({ quantity_1: "0x10" }, () =>
        restoredQuantity(1, undefined, 10, 1),
      ),
    ).toBe(0);
  });

  test("clamps a negative submitted count to zero", async () => {
    expect(
      await withSubmittedValues({ quantity_1: "-3" }, () =>
        restoredQuantity(1, undefined, 10, 1),
      ),
    ).toBe(0);
  });
});

describe("restoredChildQty", () => {
  test("stays at zero when nothing was submitted", () => {
    expect(restoredChildQty(7, 10, 5)).toBe(0);
  });

  test("restores a submitted child count, clamped high", async () => {
    expect(
      await withSubmittedValues({ child_qty_7_10: "3" }, () =>
        restoredChildQty(7, 10, 2),
      ),
    ).toBe(2);
  });
});
