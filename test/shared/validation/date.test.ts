/** The month rule's direct tests. The date parsing module's tests live in
 *  date-string.test.ts beside the parsing module. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isIsoMonth } from "#shared/validation/date.ts";

describe("isIsoMonth", () => {
  test("accepts every real month of a year", () => {
    expect(isIsoMonth("2026-01")).toBe(true);
    expect(isIsoMonth("2026-09")).toBe(true);
    expect(isIsoMonth("2026-12")).toBe(true);
  });

  test("refuses a month outside 01 to 12", () => {
    expect(isIsoMonth("2026-00")).toBe(false);
    expect(isIsoMonth("2026-13")).toBe(false);
    expect(isIsoMonth("2026-99")).toBe(false);
  });
});
