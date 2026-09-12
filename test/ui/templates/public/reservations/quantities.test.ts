import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  quantityOptions,
  restoredPackageQuantity,
  restoredQuantity,
} from "#templates/public/reservations/quantities.ts";

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
});
