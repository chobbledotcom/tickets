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
          ["isPackage", "0"],
          ["packagePrice3", "junk"],
        ]),
      ),
    ).toBeNull();
  });

  test("passes a blank field as no override", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", ""],
          ["packageQty3", " "],
          ["packageDayPrice3Days1", ""],
        ]),
      ),
    ).toBeNull();
  });

  test("names the first malformed field family", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
          ["packageQty3", "abc"],
          ["packageDayPrice3Days1", "junk"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
          ["packageDayPrice3Days1", "junk"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
  });

  test("refuses a sub-1 or non-digit quantity", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packageQty3", "0"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packageQty3", "1.5"],
        ]),
      ),
    ).toBe(t("error.package_member_quantity"));
  });

  test("refuses a negative or junk price", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "-1"],
        ]),
      ),
    ).toBe(t("error.package_member_price"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "1.234"],
        ]),
      ),
    ).toBe(t("error.package_member_price"));
  });

  test("refuses a zero or unsafe day count", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packageDayPrice3Days0", "5.00"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packageDayPrice3Days99999999999999999999", "5.00"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
  });

  test("refuses a day count above the supported maximum", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packageDayPrice3Days91", "5.00"],
        ]),
      ),
    ).toBe(t("error.package_member_day_price"));
  });

  test("accepts a well-formed member field set", () => {
    expect(
      validatePackageMemberForm(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
          ["packageQty3", "2"],
          ["packageDayPrice3Days1", "5.00"],
          ["packageDayPrice3Days2", "0"],
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
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
          ["packageQty3", "2"],
          ["packageDayPrice3Days1", "5.50"],
          ["packageDayPrice3Days2", "0"],
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
          ["isPackage", "1"],
          ["packagePrice3", ""],
        ]),
      ),
    ).toEqual([{ dayPrices: {}, listingId: 3, price: null, quantity: 1 }]);
  });

  test("refuses a malformed quantity instead of defaulting it", () => {
    expect(() =>
      parsePackageMembers(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
          ["packageQty3", "2abc"],
        ]),
      ),
    ).toThrow("Package quantity is not a whole number: 2abc");
  });

  test("keeps an empty day-price map for a member with none", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["isPackage", "1"],
          ["packagePrice3", "9.00"],
        ]),
      ),
    ).toEqual([{ dayPrices: {}, listingId: 3, price: 900, quantity: 1 }]);
  });

  test("ignores day-price keys for listings without a price key", () => {
    expect(
      parsePackageMembers(
        formOf([
          ["isPackage", "1"],
          ["packageDayPrice3Days1", "5.50"],
        ]),
      ),
    ).toEqual([]);
  });
});
