import { describe, expect, test } from "#test-compat";
import {
  type Field,
  renderError,
  renderField,
  renderFields,
} from "#lib/forms.tsx";
import {
  eventFields,
  getTicketFields,
  mergeEventFields,
  ticketFields,
  validatePhone,
} from "#templates/fields.ts";
import {
  baseEventForm,
  expectInvalid,
  expectInvalidForm,
  expectValid,
} from "#test-utils";

/** Helper: build a Field definition with minimal boilerplate. */
const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({
  type: "text",
  ...overrides,
});

/** Helper: render a field with given overrides and optional value. */
const rendered = (
  overrides: Partial<Field> & { name: string; label: string },
  value?: string,
): string => renderField(field(overrides), value);

/** Helper: build event form data with overrides. */
const eventForm = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ...baseEventForm,
  ...overrides,
});

describe("forms", () => {
  describe("renderField", () => {
    test("renders text input with label", () => {
      const html = rendered({ name: "username", label: "Username" });
      expect(html).toContain("<label>");
      expect(html).toContain("Username");
      expect(html).toContain('type="text"');
      expect(html).toContain('name="username"');
      expect(html).toContain("</label>");
    });

    test("renders required attribute", () => {
      const html = rendered({ name: "email", label: "Email", type: "email", required: true });
      expect(html).toContain("required");
    });

    test("renders placeholder", () => {
      const html = rendered({ name: "name", label: "Name", placeholder: "Enter your name" });
      expect(html).toContain('placeholder="Enter your name"');
    });

    test("renders hint text", () => {
      const html = rendered({ name: "password", label: "Password", type: "password", hint: "Minimum 8 characters" });
      expect(html).toContain("Minimum 8 characters");
      expect(html).toContain("<small");
    });

    test("renders min attribute for number", () => {
      const html = rendered({ name: "quantity", label: "Quantity", type: "number", min: 1 });
      expect(html).toContain('min="1"');
    });

    test("renders pattern attribute", () => {
      const html = rendered({ name: "code", label: "Code", pattern: "[A-Z]{3}" });
      expect(html).toContain('pattern="[A-Z]{3}"');
    });

    test("renders textarea for textarea type", () => {
      const html = rendered({ name: "description", label: "Description", type: "textarea" });
      expect(html).toContain("<textarea");
      expect(html).toContain('rows="3"');
      expect(html).not.toContain("<input");
    });

    test("renders value when provided", () => {
      const html = rendered({ name: "name", label: "Name" }, "John Doe");
      expect(html).toContain('value="John Doe"');
    });

    test("escapes HTML in value", () => {
      const html = rendered({ name: "name", label: "Name" }, '<script>alert("xss")</script>');
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    test("renders textarea with value", () => {
      const html = rendered({ name: "description", label: "Description", type: "textarea" }, "Some description");
      expect(html).toContain(">Some description</textarea>");
    });
  });

  describe("renderFields", () => {
    test("renders multiple fields", () => {
      const fields: Field[] = [
        field({ name: "name", label: "Name", required: true }),
        field({ name: "email", label: "Email", type: "email", required: true }),
      ];
      const html = renderFields(fields);
      expect(html).toContain("Name");
      expect(html).toContain("Email");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
    });

    test("renders fields with values", () => {
      const fields: Field[] = [
        field({ name: "name", label: "Name" }),
        field({ name: "count", label: "Count", type: "number" }),
      ];
      const values = { name: "Test", count: 42 };
      const html = renderFields(fields, values);
      expect(html).toContain('value="Test"');
      expect(html).toContain('value="42"');
    });

    test("handles null values", () => {
      const fields: Field[] = [field({ name: "price", label: "Price", type: "number" })];
      const html = renderFields(fields, { price: null });
      expect(html).not.toContain('value="null"');
    });
  });

  describe("validateForm", () => {
    const requiredName: Field[] = [field({ name: "name", label: "Name", required: true })];

    test("validates required fields", () => {
      expectInvalid("Name is required")(requiredName, { name: "" });
    });

    test("validates required field with whitespace only", () => {
      expectInvalidForm(requiredName, { name: "   " });
    });

    test("passes validation when required field has value", () => {
      const values = expectValid(requiredName, { name: "John" });
      expect(values.name).toBe("John");
    });

    test("parses number fields", () => {
      const fields: Field[] = [field({ name: "quantity", label: "Quantity", type: "number", required: true })];
      const values = expectValid(fields, { quantity: "42" });
      expect(values.quantity).toBe(42);
    });

    test("returns null for empty optional number", () => {
      const fields: Field[] = [field({ name: "price", label: "Price", type: "number" })];
      const values = expectValid(fields, { price: "" });
      expect(values.price).toBeNull();
    });

    test("returns null for empty optional text", () => {
      const fields: Field[] = [field({ name: "note", label: "Note" })];
      const values = expectValid(fields, { note: "" });
      expect(values.note).toBeNull();
    });

    test("runs custom validate function", () => {
      const fields: Field[] = [
        field({
          name: "code",
          label: "Code",
          required: true,
          validate: (v) => v.length !== 3 ? "Code must be 3 characters" : null,
        }),
      ];
      expectInvalid("Code must be 3 characters")(fields, { code: "AB" });
    });

    test("skips custom validate for empty optional field", () => {
      const fields: Field[] = [
        field({
          name: "code",
          label: "Code",
          validate: (v) => v.length !== 3 ? "Code must be 3 characters" : null,
        }),
      ];
      expectValid(fields, { code: "" });
    });

    test("trims values", () => {
      const values = expectValid(requiredName, { name: "  John  " });
      expect(values.name).toBe("John");
    });
  });

  describe("renderError", () => {
    test("returns empty string when no error", () => {
      expect(renderError()).toBe("");
      expect(renderError(undefined)).toBe("");
    });

    test("renders error message", () => {
      const html = renderError("Something went wrong");
      expect(html).toContain("Something went wrong");
      expect(html).toContain('class="error"');
    });

    test("escapes HTML in error message", () => {
      const html = renderError("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });
  });

  describe("eventFields validation", () => {
    test("validates thank_you_url rejects javascript: protocol", () => {
      expectInvalid("URL must use https://")(
        eventFields,
        eventForm({ thank_you_url: "javascript:alert(1)" }),
      );
    });

    test("validates thank_you_url rejects http: protocol", () => {
      expectInvalid("URL must use https://")(
        eventFields,
        eventForm({ thank_you_url: "http://example.com/thank-you" }),
      );
    });

    test("validates thank_you_url rejects invalid URL", () => {
      expectInvalid("Invalid URL format")(
        eventFields,
        eventForm({ thank_you_url: "not-a-valid-url" }),
      );
    });

    test("validates thank_you_url accepts relative URLs", () => {
      expectValid(eventFields, eventForm({ thank_you_url: "/thank-you" }));
    });

    test("validates unit_price rejects negative values", () => {
      expectInvalid("Price must be 0 or greater")(
        eventFields,
        eventForm({ unit_price: "-100" }),
      );
    });

    test("validates name is required", () => {
      const { name: _, ...formWithoutName } = baseEventForm;
      expectInvalid("Event Name is required")(eventFields, formWithoutName);
    });

    test("validates description rejects values exceeding max length", () => {
      const longDescription = "a".repeat(129);
      expectInvalid(
        "Description must be 128 characters or fewer",
      )(eventFields, eventForm({ description: longDescription }));
    });

    test("validates description accepts values within max length", () => {
      expectValid(
        eventFields,
        eventForm({ description: "a".repeat(128) }),
      );
    });

    test("validates description accepts empty value", () => {
      expectValid(eventFields, eventForm({ description: "" }));
    });
  });

  describe("ticketFields validation", () => {
    test("validates email format", () => {
      expectInvalid("Please enter a valid email address")(
        ticketFields,
        { name: "John Doe", email: "not-an-email" },
      );
    });

    test("accepts valid email", () => {
      expectValid(ticketFields, { name: "John Doe", email: "john@example.com" });
    });
  });

  describe("renderField select type", () => {
    const colorSelect: Field = {
      name: "color",
      label: "Color",
      type: "select",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
      ],
    };

    test("renders select element with options", () => {
      const html = renderField(colorSelect);
      expect(html).toContain("<select");
      expect(html).toContain('name="color"');
      expect(html).toContain('value="red"');
      expect(html).toContain(">Red</option>");
      expect(html).toContain('value="blue"');
      expect(html).toContain(">Blue</option>");
    });

    test("renders select with selected value", () => {
      const html = renderField(colorSelect, "blue");
      expect(html).toContain('value="blue" selected');
      expect(html).not.toContain('value="red" selected');
    });

    test("renders select with hint", () => {
      const fieldsSelect: Field = {
        name: "fields",
        label: "Contact Fields",
        type: "select",
        hint: "Which contact details to collect",
        options: [
          { value: "email", label: "Email" },
          { value: "phone", label: "Phone Number" },
          { value: "both", label: "Email & Phone Number" },
        ],
      };
      const html = renderField(fieldsSelect);
      expect(html).toContain("Which contact details to collect");
    });
  });

  describe("validatePhone", () => {
    test("accepts valid phone with country code", () => {
      expect(validatePhone("+1 234 567 8900")).toBeNull();
    });

    test("accepts valid phone with parentheses", () => {
      expect(validatePhone("+1 (555) 123-4567")).toBeNull();
    });

    test("accepts valid phone with hyphens", () => {
      expect(validatePhone("+44-20-1234-5678")).toBeNull();
    });

    test("accepts plain digit phone", () => {
      expect(validatePhone("1234567890")).toBeNull();
    });

    test("rejects phone too short", () => {
      expect(validatePhone("123")).not.toBeNull();
    });

    test("rejects phone with letters", () => {
      expect(validatePhone("abc1234567")).not.toBeNull();
    });

    test("rejects empty string", () => {
      expect(validatePhone("")).not.toBeNull();
    });
  });

  describe("getTicketFields", () => {
    test("returns name and email fields for email setting", () => {
      const fields = getTicketFields("email");
      expect(fields.length).toBe(2);
      expect(fields[0]!.name).toBe("name");
      expect(fields[1]!.name).toBe("email");
    });

    test("returns name and phone fields for phone setting", () => {
      const fields = getTicketFields("phone");
      expect(fields.length).toBe(2);
      expect(fields[0]!.name).toBe("name");
      expect(fields[1]!.name).toBe("phone");
    });

    test("returns name, email, and phone fields for both setting", () => {
      const fields = getTicketFields("both");
      expect(fields.length).toBe(3);
      expect(fields[0]!.name).toBe("name");
      expect(fields[1]!.name).toBe("email");
      expect(fields[2]!.name).toBe("phone");
    });

    test("phone field has validation", () => {
      const phoneField = getTicketFields("phone")[1]!;
      expect(phoneField.validate).toBeDefined();
      expect(phoneField.required).toBe(true);
    });

    test("email field has validation", () => {
      const emailField = getTicketFields("email")[1]!;
      expect(emailField.validate).toBeDefined();
      expect(emailField.required).toBe(true);
    });
  });

  describe("mergeEventFields", () => {
    test("returns email for empty array", () => {
      expect(mergeEventFields([])).toBe("email");
    });

    test("returns email when all events use email", () => {
      expect(mergeEventFields(["email", "email", "email"])).toBe("email");
    });

    test("returns phone when all events use phone", () => {
      expect(mergeEventFields(["phone", "phone"])).toBe("phone");
    });

    test("returns both when all events use both", () => {
      expect(mergeEventFields(["both", "both"])).toBe("both");
    });

    test("returns both when events differ (email + phone)", () => {
      expect(mergeEventFields(["email", "phone"])).toBe("both");
    });

    test("returns both when events differ (email + both)", () => {
      expect(mergeEventFields(["email", "both"])).toBe("both");
    });

    test("returns both when events differ (phone + both)", () => {
      expect(mergeEventFields(["phone", "both"])).toBe("both");
    });

    test("returns setting for single event", () => {
      expect(mergeEventFields(["phone"])).toBe("phone");
    });
  });

  describe("eventFields Contact Fields validation", () => {
    test("validates fields select rejects invalid value", () => {
      expectInvalid("Contact Fields must be email, phone, or both")(
        eventFields,
        eventForm({ fields: "invalid" }),
      );
    });

    test("validates fields select accepts email", () => {
      expectValid(eventFields, eventForm({ fields: "email" }));
    });

    test("validates fields select accepts phone", () => {
      expectValid(eventFields, eventForm({ fields: "phone" }));
    });

    test("validates fields select accepts both", () => {
      expectValid(eventFields, eventForm({ fields: "both" }));
    });
  });

  describe("phone ticket fields validation", () => {
    test("validates phone is required for phone-only events", () => {
      expectInvalid("Your Phone Number is required")(
        getTicketFields("phone"),
        { name: "John Doe", phone: "" },
      );
    });

    test("validates phone format for phone-only events", () => {
      expectInvalid("Please enter a valid phone number")(
        getTicketFields("phone"),
        { name: "John Doe", phone: "abc" },
      );
    });

    test("accepts valid phone for phone-only events", () => {
      expectValid(getTicketFields("phone"), { name: "John Doe", phone: "+1 555 123 4567" });
    });

    test("validates both email and phone for both setting", () => {
      expectValid(getTicketFields("both"), {
        name: "John Doe",
        email: "john@example.com",
        phone: "+1 555 123 4567",
      });
    });

    test("rejects missing phone for both setting", () => {
      expectInvalidForm(getTicketFields("both"), {
        name: "John Doe",
        email: "john@example.com",
        phone: "",
      });
    });

    test("rejects missing email for both setting", () => {
      expectInvalidForm(getTicketFields("both"), {
        name: "John Doe",
        email: "",
        phone: "+1 555 123 4567",
      });
    });
  });
});
