import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { renderFields } from "#lib/forms.tsx";
import {
  fieldsApi,
  getTicketFields,
  mergeEventFields,
  validateAddress,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields.ts";
import { expectInvalid, expectValid } from "#test-utils";

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

describe("getTicketFields — Square payment provider", () => {
  test("injects email for paid events when Square is active", () => {
    const s = stub(fieldsApi, "getSettingCached", () => "square");
    try {
      expect(fieldNames("phone", true)).toEqual(["name", "email", "phone"]);
    } finally {
      s.restore();
    }
  });

  test("does not inject email for free events", () => {
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

describe("mergeEventFields", () => {
  test("returns empty string for empty input", () => {
    expect(mergeEventFields([])).toBe("");
    expect(mergeEventFields(["", ""])).toBe("");
  });

  test("returns the single setting unchanged", () => {
    expect(mergeEventFields(["phone"])).toBe("phone");
    expect(mergeEventFields(["email,phone"])).toBe("email,phone");
  });

  test("returns the union of all fields across events", () => {
    expect(mergeEventFields(["email", "phone"])).toBe("email,phone");
    expect(mergeEventFields(["email", "phone,address"])).toBe(
      "email,phone,address",
    );
    expect(mergeEventFields(["email,special_instructions", "phone"])).toBe(
      "email,phone,special_instructions",
    );
  });

  test("sorts output in canonical CONTACT_FIELDS order", () => {
    expect(mergeEventFields(["address", "email"])).toBe("email,address");
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
