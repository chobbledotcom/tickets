import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  CONTACT_FIELDS,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { getGroupCreateForm } from "#templates/fields/group.ts";
import { getListingForm } from "#templates/fields/listing.ts";
import {
  validateBookableDays,
  validateDate,
} from "#templates/fields/validators.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";

const listingForm = (overrides: TestFormValues = {}): TestFormValues => ({
  ...baseListingForm,
  ...overrides,
});

describe("listing form required fields", () => {
  test("rejects missing listing name", () => {
    const { name: _, ...withoutName } = baseListingForm;
    expectInvalid("Listing name is required")(
      getListingForm().fields,
      withoutName,
    );
  });
});

describe("listing form description", () => {
  test("rejects description exceeding max length", () => {
    expectInvalid(
      `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
    )(
      getListingForm().fields,
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH + 1) }),
    );
  });

  test("accepts description at and below max length", () => {
    expectValid(
      getListingForm().fields,
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH) }),
    );
    expectValid(getListingForm().fields, listingForm({ description: "" }));
  });
});

describe("listing form thank_you_url", () => {
  test("accepts public https URLs", () => {
    expectValid(
      getListingForm().fields,
      listingForm({ thank_you_url: "https://example.com/thank-you" }),
    );
  });

  test("rejects http, IPs and javascript protocols", () => {
    expectInvalid("URL must use https://")(
      getListingForm().fields,
      listingForm({ thank_you_url: "http://example.com" }),
    );
    expectInvalid("URL must use https://")(
      getListingForm().fields,
      listingForm({ thank_you_url: "https://1.1.1.1/thank-you" }),
    );
    expectInvalid("URL must use https://")(
      getListingForm().fields,
      listingForm({ thank_you_url: "javascript:alert(1)" }),
    );
  });

  test("rejects malformed URLs", () => {
    expectInvalid("URL must use https://")(
      getListingForm().fields,
      listingForm({ thank_you_url: "not-a-valid-url" }),
    );
  });
});

describe("listing form webhook_url", () => {
  test("accepts valid https URLs", () => {
    expectValid(
      getListingForm().fields,
      listingForm({ webhook_url: "https://example.com/webhook" }),
    );
  });

  const rejected: Array<{ expected: string; url: string; label: string }> = [
    {
      expected: "URL must use https://",
      label: "http",
      url: "http://example.com/webhook",
    },
    {
      expected: "URL must use https://",
      label: "javascript",
      url: "javascript:alert(1)",
    },
    {
      expected: "URL must use https://",
      label: "single-label",
      url: "https://example/webhook",
    },
    {
      expected: "URL must use https://",
      label: "localhost",
      url: "https://localhost/webhook",
    },
    {
      expected: "URL must use https://",
      label: "loopback",
      url: "https://127.0.0.1/webhook",
    },
    {
      expected: "URL must use https://",
      label: "public IPv4",
      url: "https://8.8.8.8/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv6 loopback",
      url: "https://[::1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "10.x",
      url: "https://10.0.0.1/webhook",
    },
    {
      expected: "URL must use https://",
      label: "172.16.x",
      url: "https://172.16.0.1/webhook",
    },
    {
      expected: "URL must use https://",
      label: "192.168.x",
      url: "https://192.168.1.1/webhook",
    },
    {
      expected: "URL must use https://",
      label: "link-local",
      url: "https://169.254.169.254/latest",
    },
    {
      expected: "URL must use https://",
      label: "0.0.0.0",
      url: "https://0.0.0.0/webhook",
    },
    {
      expected: "URL must use https://",
      label: "broadcast",
      url: "https://255.255.255.255/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv6 unspecified",
      url: "https://[::]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv4-mapped loopback",
      url: "https://[::ffff:127.0.0.1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv4-mapped IMDS",
      url: "https://[::ffff:169.254.169.254]/latest",
    },
    {
      expected: "URL must use https://",
      label: "IPv4-mapped 10.x",
      url: "https://[::ffff:10.0.0.1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv4-mapped 192.168",
      url: "https://[::ffff:192.168.1.1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv4-mapped 0.0.0.0",
      url: "https://[::ffff:0]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv6 link-local",
      url: "https://[fe80::1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv6 ULA fc00",
      url: "https://[fc00::1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "IPv6 ULA fd00",
      url: "https://[fd12:3456:789a::1]/webhook",
    },
    {
      expected: "URL must use https://",
      label: "malformed",
      url: "not-a-valid-url",
    },
  ];

  for (const { expected, url, label } of rejected) {
    test(`rejects ${label} webhook URL`, () => {
      expectInvalid(expected)(
        getListingForm().fields,
        listingForm({ webhook_url: url }),
      );
    });
  }

  test("accepts public domains", () => {
    expectValid(
      getListingForm().fields,
      listingForm({ webhook_url: "https://app.example.net/webhook" }),
    );
    expectValid(
      getListingForm().fields,
      listingForm({ webhook_url: "https://hooks.example.org/webhook" }),
    );
  });

  test("rejects URLs without a proper domain", () => {
    expectInvalid("URL must use https://")(
      getListingForm().fields,
      listingForm({ webhook_url: "https://example/webhook" }),
    );
  });
});

describe("listing form pricing", () => {
  test("rejects negative unit_price", () => {
    expectInvalid("Price must be 0 or greater")(
      getListingForm().fields,
      listingForm({ unit_price: "-100" }),
    );
  });

  test("rejects negative max_price and accepts valid values", () => {
    expectInvalid("Price must be 0 or greater")(
      getListingForm().fields,
      listingForm({ max_price: "-50" }),
    );
    expectValid(getListingForm().fields, listingForm({ max_price: "100.00" }));
    expectValid(getListingForm().fields, listingForm({ max_price: "" }));
  });
});

describe("listing form contact fields setting", () => {
  test("rejects unknown contact field name", () => {
    expectInvalid("Invalid contact field: invalid")(
      getListingForm().fields,
      listingForm({ fields: ["invalid"] }),
    );
  });

  test("accepts known contact field values", () => {
    // Derived from the schema, so a new ContactField member is covered here the
    // moment it is added — no hand-maintained list to forget to update.
    for (const value of CONTACT_FIELDS) {
      expectValid(getListingForm().fields, listingForm({ fields: [value] }));
    }
    expectValid(
      getListingForm().fields,
      listingForm({ fields: ["email", "phone"] }),
    );
  });

  test("warns that attendees won't be emailed their ticket without email collection", () => {
    const fieldsField = getListingForm().fields.find(
      (f) => f.name === "fields",
    )!;
    expect(fieldsField.hintHtml).toContain("<strong>");
    expect(fieldsField.hintHtml).toContain("emailed their ticket");
  });
});

describe("listing form listing_type", () => {
  test("accepts standard and daily, rejects anything else", () => {
    // Every declared listing type is accepted; the schema is the source of truth.
    for (const value of ListingTypeSchema.options) {
      expectValid(
        getListingForm().fields,
        listingForm({ listing_type: value }),
      );
    }
    expectInvalid("Listing type must be standard or daily")(
      getListingForm().fields,
      listingForm({ listing_type: "weekly" }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(getListingForm().fields, listingForm());
  });
});

describe("listing form duration_days", () => {
  for (const value of ["", "1", String(MAX_DURATION_DAYS)]) {
    test(`accepts ${JSON.stringify(value)}`, () => {
      expectValid(
        getListingForm().fields,
        listingForm({ duration_days: value }),
      );
    });
  }
  const invalid: [value: string, error: string][] = [
    ["0", "Booking duration (days) must be at least 1."],
    ["-5", "Booking duration (days) must be at least 1."],
    [
      String(MAX_DURATION_DAYS + 1),
      `Booking duration (days) must be at most ${MAX_DURATION_DAYS}.`,
    ],
    ["1.5", "Booking duration (days) must be a whole number."],
  ];
  for (const [value, error] of invalid) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expectInvalid(error)(
        getListingForm().fields,
        listingForm({ duration_days: value }),
      );
    });
  }
});

describe("listing form bookable_days", () => {
  test("accepts valid day names", () => {
    expectValid(
      getListingForm().fields,
      listingForm({ bookable_days: ["Monday", "Wednesday", "Friday"] }),
    );
    expectValid(
      getListingForm().fields,
      listingForm({
        bookable_days: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
      }),
    );
  });

  test("rejects invalid day name", () => {
    expectInvalid(
      "Invalid day: Funday. Use: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday",
    )(
      getListingForm().fields,
      listingForm({ bookable_days: ["Monday", "Funday"] }),
    );
  });

  test("rejects empty-after-trimming value", () => {
    expectInvalid("At least one day is required")(
      getListingForm().fields,
      listingForm({ bookable_days: "," }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(getListingForm().fields, listingForm());
  });
});

describe("group create form", () => {
  test("rejects terms_and_conditions exceeding MAX_TEXTAREA_LENGTH", () => {
    const termsField = getGroupCreateForm().fields.find(
      (f) => f.name === "terms_and_conditions",
    )!;
    expect(
      termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH + 1)),
    ).toContain(`${MAX_TEXTAREA_LENGTH} characters or fewer`);
  });

  test("accepts terms_and_conditions within MAX_TEXTAREA_LENGTH", () => {
    const termsField = getGroupCreateForm().fields.find(
      (f) => f.name === "terms_and_conditions",
    )!;
    expect(termsField.validate?.("x".repeat(MAX_TEXTAREA_LENGTH))).toBeNull();
  });
});

describe("holiday form", () => {
  const holidayForm = (
    overrides: Record<string, string> = {},
  ): Record<string, string> => ({
    end_date: "2026-12-25",
    name: "Bank Holiday",
    start_date: "2026-12-25",
    ...overrides,
  });

  test("rejects missing name, start_date, or end_date", () => {
    expectInvalid("Holiday name is required")(
      getHolidayForm().fields,
      holidayForm({ name: "" }),
    );
    expectInvalid("Start date is required")(
      getHolidayForm().fields,
      holidayForm({ start_date: "" }),
    );
    expectInvalid("End date is required")(
      getHolidayForm().fields,
      holidayForm({ end_date: "" }),
    );
  });

  test("rejects malformed dates", () => {
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      getHolidayForm().fields,
      holidayForm({ start_date: "25-12-2026" }),
    );
    expectInvalid("Please enter a valid date (YYYY-MM-DD)")(
      getHolidayForm().fields,
      holidayForm({ end_date: "not-a-date" }),
    );
  });

  test("accepts valid single-day and multi-day holidays", () => {
    const values = expectValid(getHolidayForm().fields, holidayForm());
    expect(values.name).toBe("Bank Holiday");

    expectValid(
      getHolidayForm().fields,
      holidayForm({ end_date: "2026-12-26", start_date: "2026-12-24" }),
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
    expect(validateBookableDays("Monday,Funday")).toContain(
      "Invalid day: Funday",
    );
  });

  test("rejects empty or blank-only values", () => {
    expect(validateBookableDays(",")).toBe("At least one day is required");
    expect(validateBookableDays("  ")).toBe("At least one day is required");
  });
});
