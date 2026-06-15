import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import {
  groupCreateFields,
  holidayFields,
  listingFields,
  validateBookableDays,
  validateDate,
} from "#templates/fields.ts";
import { baseListingForm, expectInvalid, expectValid } from "#test-utils";

const listingForm = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  ...baseListingForm,
  ...overrides,
});

describe("listingFields — required fields", () => {
  test("rejects missing listing name", () => {
    const { name: _, ...withoutName } = baseListingForm;
    expectInvalid("Listing Name is required")(listingFields, withoutName);
  });
});

describe("listingFields — description", () => {
  test("rejects description exceeding max length", () => {
    expectInvalid(
      `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
    )(
      listingFields,
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH + 1) }),
    );
  });

  test("accepts description at and below max length", () => {
    expectValid(
      listingFields,
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH) }),
    );
    expectValid(listingFields, listingForm({ description: "" }));
  });
});

describe("listingFields — thank_you_url", () => {
  test("accepts relative URLs", () => {
    expectValid(listingFields, listingForm({ thank_you_url: "/thank-you" }));
  });

  test("rejects http and javascript protocols", () => {
    expectInvalid("URL must use https://")(
      listingFields,
      listingForm({ thank_you_url: "http://example.com" }),
    );
    expectInvalid("URL must use https://")(
      listingFields,
      listingForm({ thank_you_url: "javascript:alert(1)" }),
    );
  });

  test("rejects invalid URL format", () => {
    expectInvalid("Invalid URL format")(
      listingFields,
      listingForm({ thank_you_url: "not-a-valid-url" }),
    );
  });
});

describe("listingFields — webhook_url", () => {
  test("accepts valid https URLs", () => {
    expectValid(
      listingFields,
      listingForm({ webhook_url: "https://example.com/webhook" }),
    );
  });

  const rejected: Array<{ expected: string; url: string; label: string }> = [
    { expected: "URL must use https://", label: "relative", url: "/internal" },
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
      expected: "Invalid URL format",
      label: "malformed",
      url: "not-a-valid-url",
    },
  ];

  for (const { expected, url, label } of rejected) {
    test(`rejects ${label} webhook URL`, () => {
      expectInvalid(expected)(listingFields, listingForm({ webhook_url: url }));
    });
  }

  test("accepts non-private IPs that look similar", () => {
    expectValid(
      listingFields,
      listingForm({ webhook_url: "https://169.0.0.0/webhook" }),
    );
    expectValid(
      listingFields,
      listingForm({ webhook_url: "https://255.0.0.0/webhook" }),
    );
  });

  test("accepts public IPv6 addresses", () => {
    expectValid(
      listingFields,
      listingForm({ webhook_url: "https://[2001:db8::1]/webhook" }),
    );
    expectValid(
      listingFields,
      listingForm({
        webhook_url: "https://[2607:f8b0:4004:800::200e]/webhook",
      }),
    );
  });

  test("accepts a public IPv6 with a short first group", () => {
    // "ab::1" has a 2-char first group, which is too short to fall in the
    // fe80::/10 or fc00::/7 private ranges (both 4 hex digits), so it must be
    // treated as public rather than rejected.
    expectValid(
      listingFields,
      listingForm({ webhook_url: "https://[ab::1]/webhook" }),
    );
  });
});

describe("listingFields — pricing", () => {
  test("rejects negative unit_price", () => {
    expectInvalid("Price must be 0 or greater")(
      listingFields,
      listingForm({ unit_price: "-100" }),
    );
  });

  test("rejects negative max_price and accepts valid values", () => {
    expectInvalid("Price must be 0 or greater")(
      listingFields,
      listingForm({ max_price: "-50" }),
    );
    expectValid(listingFields, listingForm({ max_price: "100.00" }));
    expectValid(listingFields, listingForm({ max_price: "" }));
  });
});

describe("listingFields — contact fields setting", () => {
  test("rejects unknown contact field name", () => {
    expectInvalid("Invalid contact field: invalid")(
      listingFields,
      listingForm({ fields: "invalid" }),
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
      expectValid(listingFields, listingForm({ fields: value }));
    }
  });

  test("warns that attendees won't be emailed their ticket without email collection", () => {
    const fieldsField = listingFields.find((f) => f.name === "fields")!;
    expect(fieldsField.hintHtml).toContain("<strong>");
    expect(fieldsField.hintHtml).toContain("emailed their ticket");
  });
});

describe("listingFields — listing_type", () => {
  test("accepts standard and daily, rejects anything else", () => {
    expectValid(listingFields, listingForm({ listing_type: "standard" }));
    expectValid(listingFields, listingForm({ listing_type: "daily" }));
    expectInvalid("Listing Type must be standard or daily")(
      listingFields,
      listingForm({ listing_type: "weekly" }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(listingFields, listingForm());
  });
});

describe("listingFields — duration_days", () => {
  for (const value of ["", "1", String(MAX_DURATION_DAYS)]) {
    test(`accepts ${JSON.stringify(value)}`, () => {
      expectValid(listingFields, listingForm({ duration_days: value }));
    });
  }
  const invalid: [value: string, error: string][] = [
    ["0", "Booking Duration (days) must be at least 1"],
    ["-5", "Booking Duration (days) must be at least 1"],
    [
      String(MAX_DURATION_DAYS + 1),
      `Booking Duration (days) must be at most ${MAX_DURATION_DAYS}`,
    ],
    ["1.5", "Booking Duration (days) must be a whole number"],
  ];
  for (const [value, error] of invalid) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expectInvalid(error)(
        listingFields,
        listingForm({ duration_days: value }),
      );
    });
  }
});

describe("listingFields — bookable_days", () => {
  test("accepts valid day names", () => {
    expectValid(
      listingFields,
      listingForm({ bookable_days: "Monday,Wednesday,Friday" }),
    );
    expectValid(
      listingFields,
      listingForm({
        bookable_days:
          "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday",
      }),
    );
  });

  test("rejects invalid day name", () => {
    expectInvalid(
      "Invalid day: Funday. Use: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday",
    )(listingFields, listingForm({ bookable_days: "Monday,Funday" }));
  });

  test("rejects empty-after-trimming value", () => {
    expectInvalid("At least one day is required")(
      listingFields,
      listingForm({ bookable_days: "," }),
    );
  });

  test("accepts empty value (optional field)", () => {
    expectValid(listingFields, listingForm());
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
    end_date: "2026-12-25",
    name: "Bank Holiday",
    start_date: "2026-12-25",
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
