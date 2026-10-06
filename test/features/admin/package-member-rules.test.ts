/** Direct unit tests for the package member rules the strict form check and
 *  the parse share. The `admin package member overrides` suite exercises them
 *  through the save route; these pin each rule arm in one isolate. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  parsePackageMembers,
  validatePackageMemberForm,
} from "#routes/admin/package-member-rules.ts";
import { FormParams } from "#shared/form-data.ts";

const formOf = (entries: [string, string][]): FormParams =>
  new FormParams(entries);

describe("validatePackageMemberForm", () => {
  test("passes when the package is off, whatever the member fields hold", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "0"],
          ["package_price_3", "junk"],
        ]),
      ),
    ).toBeNull();
  });

  test("passes a blank field as no override", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", ""],
          ["package_qty_3", " "],
          ["package_day_price_3_1", ""],
        ]),
      ),
    ).toBeNull();
  });

  test("names the first malformed field family", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "9.00"],
          ["package_qty_3", "abc"],
          ["package_day_price_3_1", "junk"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "9.00"],
          ["package_day_price_3_1", "junk"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
  });

  test("refuses a sub-1 or non-digit quantity", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_qty_3", "0"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_qty_3", "1.5"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
  });

  test("refuses a negative or junk price", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "-1"],
        ]),
      ),
    ).toBe(t("error.package_member_price"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "1.234"],
        ]),
      ),
    ).toBe(t("error.package_member_price"));
  });

  test("refuses a zero or unsafe day count", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_day_price_3_0", "5.00"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_day_price_3_99999999999999999999", "5.00"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
  });

  test("accepts a well-formed member field set", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "9.00"],
          ["package_qty_3", "2"],
          ["package_day_price_3_1", "5.00"],
          ["package_day_price_3_2", "0"],
        ]),
      ),
    ).toBeNull();
  });
});

describe("parsePackageMembers", () => {
  test("folds the price, quantity, and day prices of one member", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "9.00"],
          ["package_qty_3", "2"],
          ["package_day_price_3_1", "5.50"],
          ["package_day_price_3_2", "0"],
        ]),
      ),
    ).toEqual([
      { dayPrices: { 1: 550, 2: 0 }, listingId: 3, price: 900, quantity: 2 },
    ]);
  });

  test("defaults a missing quantity to one and a blank price to no override", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["is_package", "1"],
          ["package_price_3", ""],
        ]),
      ),
    ).toEqual([{ dayPrices: {}, listingId: 3, price: null, quantity: 1 }]);
  });

  test("keeps an empty day-price map for a member with none", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["is_package", "1"],
          ["package_price_3", "9.00"],
        ]),
      ),
    ).toEqual([{ dayPrices: {}, listingId: 3, price: 900, quantity: 1 }]);
  });

  test("ignores day-price keys for listings without a price key", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["is_package", "1"],
          ["package_day_price_3_1", "5.50"],
        ]),
      ),
    ).toEqual([]);
  });
});
