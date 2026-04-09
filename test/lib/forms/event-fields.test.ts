import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#lib/limits.ts";
import {
  eventFields,
  groupCreateFields,
  holidayFields,
  validateBookableDays,
  validateDate,
} from "#templates/fields.ts";
import { baseEventForm, expectInvalid, expectValid } from "#test-utils";

const eventForm = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  ...baseEventForm,
  ...overrides,
});

describe("eventFields — required fields", () => {
  test("rejects missing event name", () => {
    const { name: _, ...withoutName } = baseEventForm;
    expectInvalid("Event Name is required")(eventFields, withoutName);
  });
});

describe("eventFields — description", () => {
  test("rejects description exceeding max length", () => {
    expectInvalid(
      `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
    )(
      eventFields,
      eventForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH + 1) }),
    );
  });

  test("accepts description at and below max length", () => {
    expectValid(
      eventFields,
      eventForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH) }),
    );
    expectValid(eventFields, eventForm({ description: "" }));
  });
});

describe("eventFields — thank_you_url", () => {
  test("accepts relative URLs", () => {
    expectValid(eventFields, eventForm({ thank_you_url: "/thank-you" }));
  });

  test("rejects http and javascript protocols", () => {
    expectInvalid("URL must use https://")(
      eventFields,
      eventForm({ thank_you_url: "http://example.com" }),
    );
    expectInvalid("URL must use https://")(
      eventFields,
      eventForm({ thank_you_url: "javascript:alert(1)" }),
    );
  });

  test("rejects invalid URL format", () => {
    expectInvalid("Invalid URL format")(
      eventFields,
      eventForm({ thank_you_url: "not-a-valid-url" }),
    );
  });
});

describe("eventFields — pricing", () => {
  test("rejects negative unit_price", () => {
    expectInvalid("Price must be 0 or greater")(
      eventFields,
      eventForm({ unit_price: "-100" }),
    );
  });

  test("rejects negative max_price and accepts valid values", () => {
    expectInvalid("Price must be 0 or greater")(
      eventFields,
      eventForm({ max_price: "-50" }),
    );
    expectValid(eventFields, eventForm({ max_price: "100.00" }));
    expectValid(eventFields, eventForm({ max_price: "" }));
  });
});

describe("eventFields — contact fields setting", () => {
  test("rejects unknown contact field name", () => {
    expectInvalid("Invalid contact field: invalid")(
      eventFields,
      eventForm({ fields: "invalid" }),
    );
  });

  test("accepts known contact field values", () => {
    for (const value of [
      "email",
      "phone",
      "address",
      "special_instructions",
      "email,phone",
    ]) {
      expectValid(eventFields, eventForm({ fields: value }));
    }
  });
});

describe("eventFields — event_type", () => {
  test("accepts standard and daily, rejects anything else", () => {
    expectValid(eventFields, eventForm({ event_type: "standard" }));
    expectValid(eventFields, eventForm({ event_type: "daily" }));
    expectInvalid("Event Type must be standard or daily")(
      eventFields,
      eventForm({ event_type: "weekly" }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(eventFields, eventForm());
  });
});

describe("eventFields — bookable_days", () => {
  test("accepts valid day names", () => {
    expectValid(
      eventFields,
      eventForm({ bookable_days: "Monday,Wednesday,Friday" }),
    );
    expectValid(
      eventFields,
      eventForm({
        bookable_days:
          "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday",
      }),
    );
  });

  test("rejects invalid day name", () => {
    expectInvalid(
      "Invalid day: Funday. Use: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday",
    )(eventFields, eventForm({ bookable_days: "Monday,Funday" }));
  });

  test("rejects empty-after-trimming value", () => {
    expectInvalid("At least one day is required")(
      eventFields,
      eventForm({ bookable_days: "," }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(eventFields, eventForm());
  });
});

describe("groupCreateFields", () => {
  test("rejects terms_and_conditions exceeding MAX_TEXTAREA_LENGTH", () => {
    const termsField = groupCreateFields.find(
      (f) => f.name === "terms_and_conditions",
    )!;
    expect(
      termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH + 1)),
    ).toContain(`${MAX_TEXTAREA_LENGTH} characters or fewer`);
  });

  test("accepts terms_and_conditions within MAX_TEXTAREA_LENGTH", () => {
    const termsField = groupCreateFields.find(
      (f) => f.name === "terms_and_conditions",
    )!;
    expect(termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
  });
});

describe("holidayFields", () => {
  const holidayForm = (
    overrides: Record<string, string> = {},
  ): Record<string, string> => ({
    name: "Bank Holiday",
    start_date: "2026-12-25",
    end_date: "2026-12-25",
    ...overrides,
  });

  test("rejects missing name, start_date, or end_date", () => {
    expectInvalid("Holiday Name is required")(
      holidayFields,
      holidayForm({ name: "" }),
    );
    expectInvalid("Start Date is required")(
      holidayFields,
      holidayForm({ start_date: "" }),
    );
    expectInvalid("End Date is required")(
      holidayFields,
      holidayForm({ end_date: "" }),
    );
  });

  test("rejects malformed dates", () => {
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      holidayFields,
      holidayForm({ start_date: "25-12-2026" }),
    );
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      holidayFields,
      holidayForm({ end_date: "not-a-date" }),
    );
  });

  test("accepts valid single-day and multi-day holidays", () => {
    const values = expectValid(holidayFields, holidayForm());
    expect(values.name).toBe("Bank Holiday");

    expectValid(
      holidayFields,
      holidayForm({ start_date: "2026-12-24", end_date: "2026-12-26" }),
    );
  });
});

describe("validateDate", () => {
  test("accepts valid dates including leap day", () => {
    expect(validateDate("2026-12-25")).toBeNull();
    expect(validateDate("2028-02-29")).toBeNull();
  });

  test("rejects wrong format", () => {
    expect(validateDate("12/25/2026")).toBe(
      "Please enter a valid date (YYYY-MM-DD)",
    );
    expect(validateDate("2026-12")).toBe(
      "Please enter a valid date (YYYY-MM-DD)",
    );
    expect(validateDate("not-a-date")).toBe(
      "Please enter a valid date (YYYY-MM-DD)",
    );
    expect(validateDate("")).toBe("Please enter a valid date (YYYY-MM-DD)");
  });

  test("rejects month 00 and month 13 as impossible dates", () => {
    expect(validateDate("2026-00-01")).toBe("Please enter a valid date");
    expect(validateDate("2026-13-01")).toBe("Please enter a valid date");
  });
});

describe("validateBookableDays", () => {
  test("accepts valid day names with and without whitespace", () => {
    expect(validateBookableDays("Monday")).toBeNull();
    expect(validateBookableDays("Monday,Wednesday,Friday")).toBeNull();
    expect(validateBookableDays(" Monday , Friday ")).toBeNull();
  });

  test("rejects invalid day name", () => {
    expect(validateBookableDays("Monday,Funday")).toContain(
      "Invalid day: Funday",
    );
  });

  test("rejects empty or blank-only values", () => {
    expect(validateBookableDays(",")).toBe("At least one day is required");
    expect(validateBookableDays("  ")).toBe("At least one day is required");
  });
});
