import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { getGroupCreateForm } from "#templates/fields/group.ts";
import {
  validateBookableDays,
  validateDate,
} from "#templates/fields/validators.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";

describe("group create form", () => {
  test("rejects terms_and_conditions exceeding MAX_TEXTAREA_LENGTH", () => {
    const termsField = getGroupCreateForm().fields.find(
      (f) => f.name === "termsAndConditions",
    )!;
    assertStringIncludes(
      termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH + 1)) ?? "",
      `${MAX_TEXTAREA_LENGTH} characters or fewer`,
    );
  });

  test("accepts terms_and_conditions within MAX_TEXTAREA_LENGTH", () => {
    const termsField = getGroupCreateForm().fields.find(
      (f) => f.name === "termsAndConditions",
    )!;
    expect(termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
  });
});

describe("holiday form", () => {
  const holidayForm = (
    overrides: Record<string, string> = {},
  ): Record<string, string> => ({
    endDate: "2026-12-25",
    name: "Bank Holiday",
    startDate: "2026-12-25",
    ...overrides,
  });

  test("rejects missing name, start_date, or end_date", () => {
    expectInvalid("Holiday name is required")(
      getHolidayForm().fields,
      holidayForm({ name: "" }),
    );
    expectInvalid("Start date is required")(
      getHolidayForm().fields,
      holidayForm({ startDate: "" }),
    );
    expectInvalid("End date is required")(
      getHolidayForm().fields,
      holidayForm({ endDate: "" }),
    );
  });

  test("rejects malformed dates", () => {
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      getHolidayForm().fields,
      holidayForm({ startDate: "25-12-2026" }),
    );
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      getHolidayForm().fields,
      holidayForm({ endDate: "not-a-date" }),
    );
  });

  test("accepts valid single-day and multi-day holidays", () => {
    const values = expectValid(getHolidayForm().fields, holidayForm());
    expect(values.name).toBe("Bank Holiday");

    expectValid(
      getHolidayForm().fields,
      holidayForm({ endDate: "2026-12-26", startDate: "2026-12-24" }),
    );
  });
});

describe("validateDate", () => {
  test("returns null for a valid date", () => {
    expect(validateDate("2026-12-25")).toBeNull();
    expect(validateDate("2028-02-29")).toBeNull();
  });

  test("returns the error message for an invalid date", () => {
    // Exhaustive format/calendar coverage lives in the isIsoDate unit test;
    // this only verifies validateDate maps a rejection to its message.
    expect(validateDate("12/25/2026")).toBe(
      "Please enter a valid date (YYYY-MM-DD)",
    );
    expect(validateDate("2026-02-30")).toBe(
      "Please enter a valid date (YYYY-MM-DD)",
    );
    expect(validateDate("")).toBe("Please enter a valid date (YYYY-MM-DD)");
  });
});

describe("validateBookableDays", () => {
  test("accepts valid day names with and without whitespace", () => {
    expect(validateBookableDays("Monday")).toBeNull();
    expect(validateBookableDays("Monday,Wednesday,Friday")).toBeNull();
    expect(validateBookableDays(" Monday , Friday ")).toBeNull();
  });

  test("rejects invalid day name", () => {
    assertStringIncludes(
      validateBookableDays("Monday,Funday") ?? "",
      "Invalid day: Funday",
    );
  });

  test("rejects empty or blank-only values", () => {
    expect(validateBookableDays(",")).toBe("At least one day is required");
    expect(validateBookableDays("  ")).toBe("At least one day is required");
  });
});
