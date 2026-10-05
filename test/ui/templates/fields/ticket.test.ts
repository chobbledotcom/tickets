import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { renderFields } from "#shared/forms/rendering.tsx";
import { mergeListingFields } from "#shared/listing-fields.ts";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import {
  extractContact,
  fieldsApi,
  getTicketFields,
  SUBDOMAIN_INPUT_PATTERN,
} from "#templates/fields/ticket.ts";
import {
  validateAddress,
  validateEmail,
  validateName,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields/validators.ts";
import { expectInvalid, expectValid } from "#test-utils/validation.ts";

// Helper: get the names of fields in order
const fieldNames = (setting: string, isPaid = false): string[] =>
  getTicketFields(setting, isPaid).map((f) => f.name);

describe("getTicketFields — field composition", () => {
  test("includes the correct contact fields in order for each setting", () => {
    expect(fieldNames("email")).toEqual(["name", "email"]);
    expect(fieldNames("phone")).toEqual(["name", "phone"]);
    expect(fieldNames("address")).toEqual(["name", "address"]);
    expect(fieldNames("special_instructions")).toEqual([
      "name",
      "special_instructions",
    ]);
    expect(fieldNames("email,phone")).toEqual(["name", "email", "phone"]);
    expect(fieldNames("email,phone,address,special_instructions")).toEqual([
      "name",
      "email",
      "phone",
      "address",
      "special_instructions",
    ]);
  });

  test("ignores unknown field names", () => {
    expect(fieldNames("email,bogus,phone")).toEqual(["name", "email", "phone"]);
  });

  test("returns only name for empty setting", () => {
    expect(fieldNames("")).toEqual(["name"]);
  });

  test("pins the name and email field definitions", () => {
    expect(getTicketFields("email", false)).toEqual([
      {
        autocomplete: "name",
        label: "Your Name",
        maxlength: 250,
        name: "name",
        required: true,
        type: "text",
        validate: validateName,
      },
      {
        autocomplete: "email",
        label: "Your Email",
        maxlength: 250,
        name: "email",
        required: true,
        type: "email",
        validate: validateEmail,
      },
    ]);
  });

  test("pins the phone field's pattern and tooltip", () => {
    const phone = getTicketFields("phone", false)[1]!;
    expect(phone.pattern).toBe("[+\\d][\\d\\s\\-\\(\\)]{5,}");
    expect(phone.title).toBe(
      "Phone number (digits, spaces, hyphens, parentheses, optional leading +)",
    );
  });

  test("keeps the subdomain input pattern a DNS label", () => {
    expect(SUBDOMAIN_INPUT_PATTERN).toBe(
      "[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?",
    );
  });

  test("attaches the lookup panel to the address field only when a provider is set", () => {
    const settingsAny = settings as unknown as Record<string, unknown>;
    const original: typeof settings.addressLookup = settings.addressLookup;
    try {
      settingsAny.addressLookup = { ...original, provider: "none" };
      const plain = getTicketFields("address", false)[1]!;
      expect(plain.beforeHtml).toBeUndefined();

      settingsAny.addressLookup = { ...original, provider: "easypostcodes" };
      const withPanel = getTicketFields("address", false)[1]!;
      expect(typeof withPanel.beforeHtml).toBe("string");
      expect(withPanel.beforeHtml).toContain("<fieldset");
      // The panel never attaches to a non-address field.
      const email = getTicketFields("email", false)[1]!;
      expect(email.beforeHtml).toBeUndefined();
    } finally {
      settingsAny.addressLookup = original;
    }
  });
});

describe("extractContact", () => {
  test("reads every contact field from validated values", () => {
    expect(
      extractContact({
        address: "1 Road",
        email: "ada@example.com",
        name: "Ada Byron",
        phone: "07946 123456",
        special_instructions: "Leave at the desk",
      }),
    ).toEqual({
      address: "1 Road",
      email: "ada@example.com",
      name: "Ada Byron",
      phone: "07946 123456",
      special_instructions: "Leave at the desk",
    });
  });

  test("answers with empty strings for absent optional fields", () => {
    expect(
      extractContact({
        address: null,
        email: null,
        name: "Ada Byron",
        phone: null,
        special_instructions: null,
      }),
    ).toEqual({
      address: "",
      email: "",
      name: "Ada Byron",
      phone: "",
      special_instructions: "",
    });
  });
});

describe("getTicketFields — field validation", () => {
  test("email field validates format and is required", () => {
    expectInvalid("Please enter a valid email address")(
      getTicketFields("email", false),
      { email: "not-an-email", name: "Jane" },
    );
    expectValid(getTicketFields("email", false), {
      email: "jane@example.com",
      name: "Jane",
    });
  });

  test("phone field validates format and is required", () => {
    expectInvalid("Please enter a valid phone number")(
      getTicketFields("phone", false),
      { name: "Jane", phone: "abc" },
    );
    expectInvalid("Your Phone Number is required")(
      getTicketFields("phone", false),
      { name: "Jane", phone: "" },
    );
    expectValid(getTicketFields("phone", false), {
      name: "Jane",
      phone: "+1 555 123 4567",
    });
  });

  test("address field is required and validates length", () => {
    expectInvalid("Your Address is required")(
      getTicketFields("address", false),
      { address: "", name: "Jane" },
    );
    expectValid(getTicketFields("address", false), {
      address: "123 Main St",
      name: "Jane",
    });
  });

  test("special_instructions field is required", () => {
    expectInvalid("Special Instructions is required")(
      getTicketFields("special_instructions", false),
      { name: "Jane", special_instructions: "" },
    );
  });

  test("renders with correct autocomplete attributes for HTML", () => {
    const html = renderFields(getTicketFields("email,phone,address", false));
    expect(html).toContain('autocomplete="name"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('autocomplete="tel"');
    expect(html).toContain('autocomplete="street-address"');
  });
});

describe("getAddAttendeeFields — autocomplete", () => {
  test("disables native autofill on the admin contact fields", () => {
    // Admin enters another person's PII here; the browser must not store or
    // suggest it, so every contact field is forced to autocomplete="off"
    // (unlike the public ticket form, which keeps semantic autocomplete).
    const fields = getAddAttendeeFields("email,phone,address", false);
    const contactFields = fields.filter((f) =>
      ["name", "email", "phone", "address"].includes(f.name),
    );
    expect(contactFields).toHaveLength(4);
    for (const field of contactFields) {
      expect(field.autocomplete).toBe("off");
    }
    const html = renderFields(fields);
    expect(html).not.toContain('autocomplete="email"');
    expect(html).not.toContain('autocomplete="tel"');
    expect(html).not.toContain('autocomplete="street-address"');
  });
});

describe("getTicketFields — Square payment provider", () => {
  test("injects email for paid listings when Square is active", () => {
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      expect(fieldNames("phone", true)).toEqual(["name", "email", "phone"]);
    } finally {
      s.restore();
    }
  });

  test("does not inject email for free listings", () => {
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      expect(fieldNames("phone", false)).toEqual(["name", "phone"]);
    } finally {
      s.restore();
    }
  });

  test("does not duplicate email when already present", () => {
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      expect(fieldNames("email,phone", true)).toEqual([
        "name",
        "email",
        "phone",
      ]);
    } finally {
      s.restore();
    }
  });

  test("injects email even for empty fields setting when paid", () => {
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      expect(fieldNames("", true)).toEqual(["name", "email"]);
    } finally {
      s.restore();
    }
  });
});

describe("mergeListingFields", () => {
  test("returns empty string for empty input", () => {
    expect(mergeListingFields([])).toBe("");
    expect(mergeListingFields(["", ""])).toBe("");
  });

  test("returns the single setting unchanged", () => {
    expect(mergeListingFields(["phone"])).toBe("phone");
    expect(mergeListingFields(["email,phone"])).toBe("email,phone");
  });

  test("returns the union of all fields across listings", () => {
    expect(mergeListingFields(["email", "phone"])).toBe("email,phone");
    expect(mergeListingFields(["email", "phone,address"])).toBe(
      "email,phone,address",
    );
    expect(mergeListingFields(["email,special_instructions", "phone"])).toBe(
      "email,phone,special_instructions",
    );
  });

  test("sorts output in canonical CONTACT_FIELDS order", () => {
    expect(mergeListingFields(["address", "email"])).toBe("email,address");
  });
});

describe("validatePhone", () => {
  test("accepts international and local formats", () => {
    expect(validatePhone("+1 234 567 8900")).toBeNull();
    expect(validatePhone("+1 (555) 123-4567")).toBeNull();
    expect(validatePhone("+44-20-1234-5678")).toBeNull();
    expect(validatePhone("1234567890")).toBeNull();
  });

  test("rejects short, lettered, or empty values", () => {
    expect(validatePhone("123")).not.toBeNull();
    expect(validatePhone("abc1234567")).not.toBeNull();
    expect(validatePhone("")).not.toBeNull();
  });

  test("rejects a phone number too long for checkout metadata", () => {
    expect(validatePhone("2".repeat(33))).toBe(
      "Phone number must be 32 characters or fewer",
    );
    expect(validatePhone("2".repeat(32))).toBeNull();
  });
});

describe("validateName", () => {
  test("accepts a name within 250 characters", () => {
    expect(validateName("Ada Lovelace")).toBeNull();
    expect(validateName("n".repeat(250))).toBeNull();
  });

  test("rejects a name too long for checkout metadata", () => {
    expect(validateName("n".repeat(251))).toBe(
      "Name must be 250 characters or fewer",
    );
  });
});

describe("validateAddress", () => {
  test("accepts addresses within 250 characters", () => {
    expect(validateAddress("123 Main St")).toBeNull();
    expect(validateAddress("a".repeat(250))).toBeNull();
    expect(
      validateAddress("123 Main St\nApt 4\nSpringfield, IL 62701"),
    ).toBeNull();
  });

  test("rejects addresses over 250 characters", () => {
    expect(validateAddress("a".repeat(251))).toBe(
      "Address must be 250 characters or fewer",
    );
  });
});

describe("validateSpecialInstructions", () => {
  test("accepts instructions within 250 characters", () => {
    expect(validateSpecialInstructions("No nuts please")).toBeNull();
    expect(validateSpecialInstructions("a".repeat(250))).toBeNull();
  });

  test("rejects instructions over 250 characters", () => {
    expect(validateSpecialInstructions("a".repeat(251))).toBe(
      "Special instructions must be 250 characters or fewer",
    );
  });
});
