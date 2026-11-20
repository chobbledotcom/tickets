import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  listingForm,
  ownerFields,
} from "#test/ui/templates/fields/listing/owner-form.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";
import { CONTACT_FIELDS, ListingTypeSchema, MAX_DURATION_DAYS } from "#types";

describe("listing form required fields", () => {
  test("rejects missing listing name", () => {
    const { name: _, ...withoutName } = baseListingForm;
    expectInvalid("Listing name is required")(ownerFields(), withoutName);
  });
});

describe("listing form description", () => {
  test("rejects description exceeding max length", () => {
    expectInvalid(
      `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
    )(
      ownerFields(),
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH + 1) }),
    );
  });

  test("accepts description at and below max length", () => {
    expectValid(
      ownerFields(),
      listingForm({ description: "a".repeat(MAX_TEXTAREA_LENGTH) }),
    );
    expectValid(ownerFields(), listingForm({ description: "" }));
  });
});

describe("listing form URL fields", () => {
  /** The two URL boxes the page draws. Both take a public https address. */
  const URL_BOXES = ["thankYouUrl", "webhookUrl"] as const;

  test("accepts public https URLs", () => {
    for (const field of URL_BOXES) {
      expectValid(
        ownerFields(),
        listingForm({ [field]: "https://example.com/page" }),
      );
    }
  });

  test("rejects http, IPs and javascript protocols", () => {
    for (const field of URL_BOXES) {
      for (const url of [
        "http://example.com",
        "https://1.1.1.1/page",
        "javascript:alert(1)",
      ]) {
        expectInvalid("URL must use https://")(
          ownerFields(),
          listingForm({ [field]: url }),
        );
      }
    }
  });

  test("rejects malformed URLs", () => {
    for (const field of URL_BOXES) {
      expectInvalid("URL must use https://")(
        ownerFields(),
        listingForm({ [field]: "not-a-valid-url" }),
      );
    }
  });

  /** Addresses that are not a public domain: a private, loopback, or local
   *  name, or a shape the URL parser refuses. */
  const BLOCKED_HOSTS = [
    "http://example.com/webhook",
    "javascript:alert(1)",
    "https://example/webhook",
    "https://localhost/webhook",
    "https://127.0.0.1/webhook",
    "https://8.8.8.8/webhook",
    "https://[::1]/webhook",
    "https://10.0.0.1/webhook",
    "https://172.16.0.1/webhook",
    "https://192.168.1.1/webhook",
    "https://169.254.169.254/latest",
    "https://0.0.0.0/webhook",
    "https://255.255.255.255/webhook",
    "https://[::]/webhook",
    "https://[::ffff:127.0.0.1]/webhook",
    "https://[::ffff:169.254.169.254]/latest",
    "https://[::ffff:10.0.0.1]/webhook",
    "https://[::ffff:192.168.1.1]/webhook",
    "https://[::ffff:0]/webhook",
    "https://[fe80::1]/webhook",
    "https://[fc00::1]/webhook",
    "https://[fd12:3456:789a::1]/webhook",
    "not-a-valid-url",
  ];

  test("rejects a host that is not a public domain", () => {
    for (const url of BLOCKED_HOSTS) {
      expectInvalid("URL must use https://")(
        ownerFields(),
        listingForm({ webhookUrl: url }),
      );
    }
  });

  test("accepts public domains", () => {
    for (const url of [
      "https://app.example.net/webhook",
      "https://hooks.example.org/webhook",
    ]) {
      expectValid(ownerFields(), listingForm({ webhookUrl: url }));
    }
  });
});

describe("listing form contact fields setting", () => {
  test("rejects unknown contact field name", () => {
    expectInvalid("Invalid contact field: invalid")(
      ownerFields(),
      listingForm({ fields: ["invalid"] }),
    );
  });

  test("accepts known contact field values", () => {
    // Derived from the schema, so a new ContactField member is covered here the
    // moment it is added — no hand-maintained list to forget to update.
    for (const value of CONTACT_FIELDS) {
      expectValid(ownerFields(), listingForm({ fields: [value] }));
    }
    expectValid(ownerFields(), listingForm({ fields: ["email", "phone"] }));
  });

  test("warns that attendees won't be emailed their ticket without email collection", () => {
    const fieldsField = ownerFields().find((f) => f.name === "fields")!;
    expectIncludesAll(fieldsField.hintHtml, [
      "<strong>",
      "emailed their ticket",
    ]);
  });
});

describe("listing form listing_type", () => {
  test("accepts standard and daily, rejects anything else", () => {
    // Every declared listing type is accepted; the schema is the source of truth.
    for (const value of ListingTypeSchema.options) {
      expectValid(ownerFields(), listingForm({ listingType: value }));
    }
    expectInvalid("Listing type must be standard or daily.")(
      ownerFields(),
      listingForm({ listingType: "weekly" }),
    );
  });

  test("accepts empty value (optional field)", () => {
    const values = expectValid(ownerFields(), listingForm());
    expect(values.listingType).toBeNull();
  });
});

describe("listing form duration_days", () => {
  for (const value of ["1", String(MAX_DURATION_DAYS)]) {
    test(`accepts ${JSON.stringify(value)}`, () => {
      expectValid(ownerFields(), listingForm({ durationDays: value }));
    });
  }
  const invalid: [value: string, error: string][] = [
    ["", "Booking duration (days) is required"],
    ["0", "Booking duration (days) must be 1 or greater"],
    ["-5", "Booking duration (days) must be 1 or greater"],
    [
      String(MAX_DURATION_DAYS + 1),
      `Booking duration (days) must be ${MAX_DURATION_DAYS} or fewer`,
    ],
    ["1.5", "Booking duration (days) must be a whole number."],
  ];
  for (const [value, error] of invalid) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expectInvalid(error)(ownerFields(), listingForm({ durationDays: value }));
    });
  }
});

describe("listing form bookable_days", () => {
  test("accepts valid day names", () => {
    expectValid(
      ownerFields(),
      listingForm({ bookableDays: ["Monday", "Wednesday", "Friday"] }),
    );
    expectValid(
      ownerFields(),
      listingForm({
        bookableDays: [
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
    )(ownerFields(), listingForm({ bookableDays: ["Monday", "Funday"] }));
  });

  test("rejects empty-after-trimming value", () => {
    expectInvalid("At least one day is required")(
      ownerFields(),
      listingForm({ bookableDays: "," }),
    );
  });

  test("accepts empty value (optional field)", () => {
    const values = expectValid(ownerFields(), listingForm());
    expect(values.bookableDays).toBe("");
  });
});
