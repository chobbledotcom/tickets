import { describe, expect, test } from "#test-compat";
import {
  type Field,
  renderError,
  renderField,
  renderFields,
  validateForm,
} from "#lib/forms.tsx";
import {
  eventFields,
  getTicketFields,
  mergeEventFields,
  ticketFields,
  validatePhone,
} from "#templates/fields.ts";

describe("forms", () => {
  describe("renderField", () => {
    test("renders text input with label", () => {
      const field: Field = {
        name: "username",
        label: "Username",
        type: "text",
      };
      const html = renderField(field);
      expect(html).toContain("<label>");
      expect(html).toContain("Username");
      expect(html).toContain('type="text"');
      expect(html).toContain('name="username"');
      expect(html).toContain("</label>");
    });

    test("renders required attribute", () => {
      const field: Field = {
        name: "email",
        label: "Email",
        type: "email",
        required: true,
      };
      const html = renderField(field);
      expect(html).toContain("required");
    });

    test("renders placeholder", () => {
      const field: Field = {
        name: "name",
        label: "Name",
        type: "text",
        placeholder: "Enter your name",
      };
      const html = renderField(field);
      expect(html).toContain('placeholder="Enter your name"');
    });

    test("renders hint text", () => {
      const field: Field = {
        name: "password",
        label: "Password",
        type: "password",
        hint: "Minimum 8 characters",
      };
      const html = renderField(field);
      expect(html).toContain("Minimum 8 characters");
      expect(html).toContain("<small");
    });

    test("renders min attribute for number", () => {
      const field: Field = {
        name: "quantity",
        label: "Quantity",
        type: "number",
        min: 1,
      };
      const html = renderField(field);
      expect(html).toContain('min="1"');
    });

    test("renders pattern attribute", () => {
      const field: Field = {
        name: "code",
        label: "Code",
        type: "text",
        pattern: "[A-Z]{3}",
      };
      const html = renderField(field);
      expect(html).toContain('pattern="[A-Z]{3}"');
    });

    test("renders textarea for textarea type", () => {
      const field: Field = {
        name: "description",
        label: "Description",
        type: "textarea",
      };
      const html = renderField(field);
      expect(html).toContain("<textarea");
      expect(html).toContain('rows="3"');
      expect(html).not.toContain("<input");
    });

    test("renders value when provided", () => {
      const field: Field = {
        name: "name",
        label: "Name",
        type: "text",
      };
      const html = renderField(field, "John Doe");
      expect(html).toContain('value="John Doe"');
    });

    test("escapes HTML in value", () => {
      const field: Field = {
        name: "name",
        label: "Name",
        type: "text",
      };
      const html = renderField(field, '<script>alert("xss")</script>');
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    test("renders textarea with value", () => {
      const field: Field = {
        name: "description",
        label: "Description",
        type: "textarea",
      };
      const html = renderField(field, "Some description");
      expect(html).toContain(">Some description</textarea>");
    });
  });

  describe("renderFields", () => {
    test("renders multiple fields", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
      ];
      const html = renderFields(fields);
      expect(html).toContain("Name");
      expect(html).toContain("Email");
      expect(html).toContain('name="name"');
      expect(html).toContain('name="email"');
    });

    test("renders fields with values", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text" },
        { name: "count", label: "Count", type: "number" },
      ];
      const values = { name: "Test", count: 42 };
      const html = renderFields(fields, values);
      expect(html).toContain('value="Test"');
      expect(html).toContain('value="42"');
    });

    test("handles null values", () => {
      const fields: Field[] = [
        { name: "price", label: "Price", type: "number" },
      ];
      const values = { price: null };
      const html = renderFields(fields, values);
      expect(html).not.toContain('value="null"');
    });
  });

  describe("validateForm", () => {
    test("validates required fields", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text", required: true },
      ];
      const form = new URLSearchParams({ name: "" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Name is required");
      }
    });

    test("validates required field with whitespace only", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text", required: true },
      ];
      const form = new URLSearchParams({ name: "   " });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
    });

    test("passes validation when required field has value", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text", required: true },
      ];
      const form = new URLSearchParams({ name: "John" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.name).toBe("John");
      }
    });

    test("parses number fields", () => {
      const fields: Field[] = [
        { name: "quantity", label: "Quantity", type: "number", required: true },
      ];
      const form = new URLSearchParams({ quantity: "42" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.quantity).toBe(42);
      }
    });

    test("returns null for empty optional number", () => {
      const fields: Field[] = [
        { name: "price", label: "Price", type: "number" },
      ];
      const form = new URLSearchParams({ price: "" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.price).toBeNull();
      }
    });

    test("returns null for empty optional text", () => {
      const fields: Field[] = [{ name: "note", label: "Note", type: "text" }];
      const form = new URLSearchParams({ note: "" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.note).toBeNull();
      }
    });

    test("runs custom validate function", () => {
      const fields: Field[] = [
        {
          name: "code",
          label: "Code",
          type: "text",
          required: true,
          validate: (v) =>
            v.length !== 3 ? "Code must be 3 characters" : null,
        },
      ];
      const form = new URLSearchParams({ code: "AB" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Code must be 3 characters");
      }
    });

    test("skips custom validate for empty optional field", () => {
      const fields: Field[] = [
        {
          name: "code",
          label: "Code",
          type: "text",
          validate: (v) =>
            v.length !== 3 ? "Code must be 3 characters" : null,
        },
      ];
      const form = new URLSearchParams({ code: "" });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
    });

    test("trims values", () => {
      const fields: Field[] = [
        { name: "name", label: "Name", type: "text", required: true },
      ];
      const form = new URLSearchParams({ name: "  John  " });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.name).toBe("John");
      }
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
      const form = new URLSearchParams({
        slug: "my-event",
        name: "Event",
        description: "Desc",
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "javascript:alert(1)",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("URL must use https:// or http://");
      }
    });

    test("validates thank_you_url rejects invalid URL", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        name: "Event",
        description: "Desc",
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "not-a-valid-url",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid URL format");
      }
    });

    test("validates thank_you_url accepts relative URLs", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        name: "Event",
        description: "Desc",
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "/thank-you",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(true);
    });

    test("validates unit_price rejects negative values", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        name: "Event",
        description: "Desc",
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "https://example.com",
        unit_price: "-100",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Price must be 0 or greater");
      }
    });

    test("validates slug format", () => {
      const form = new URLSearchParams({
        slug: "INVALID_SLUG",
        name: "Event",
        description: "Desc",
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "https://example.com",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("lowercase");
      }
    });

    test("validates slug is required", () => {
      const form = new URLSearchParams({
        max_attendees: "100",
        max_quantity: "1",
        thank_you_url: "https://example.com",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Identifier is required");
      }
    });
  });

  describe("ticketFields validation", () => {
    test("validates email format", () => {
      const form = new URLSearchParams({
        name: "John Doe",
        email: "not-an-email",
      });
      const result = validateForm(form, ticketFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Please enter a valid email address");
      }
    });

    test("accepts valid email", () => {
      const form = new URLSearchParams({
        name: "John Doe",
        email: "john@example.com",
      });
      const result = validateForm(form, ticketFields);
      expect(result.valid).toBe(true);
    });
  });

  describe("renderField select type", () => {
    test("renders select element with options", () => {
      const field: Field = {
        name: "color",
        label: "Color",
        type: "select",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      };
      const html = renderField(field);
      expect(html).toContain("<select");
      expect(html).toContain('name="color"');
      expect(html).toContain('value="red"');
      expect(html).toContain(">Red</option>");
      expect(html).toContain('value="blue"');
      expect(html).toContain(">Blue</option>");
    });

    test("renders select with selected value", () => {
      const field: Field = {
        name: "color",
        label: "Color",
        type: "select",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      };
      const html = renderField(field, "blue");
      expect(html).toContain('value="blue" selected');
      expect(html).not.toContain('value="red" selected');
    });

    test("renders select with hint", () => {
      const field: Field = {
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
      const html = renderField(field);
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
      const fields = getTicketFields("phone");
      const phoneField = fields[1]!;
      expect(phoneField.validate).toBeDefined();
      expect(phoneField.required).toBe(true);
    });

    test("email field has validation", () => {
      const fields = getTicketFields("email");
      const emailField = fields[1]!;
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
      const form = new URLSearchParams({
        slug: "my-event",
        max_attendees: "100",
        max_quantity: "1",
        fields: "invalid",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Contact Fields must be email, phone, or both");
      }
    });

    test("validates fields select accepts email", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        max_attendees: "100",
        max_quantity: "1",
        fields: "email",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(true);
    });

    test("validates fields select accepts phone", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        max_attendees: "100",
        max_quantity: "1",
        fields: "phone",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(true);
    });

    test("validates fields select accepts both", () => {
      const form = new URLSearchParams({
        slug: "my-event",
        max_attendees: "100",
        max_quantity: "1",
        fields: "both",
      });
      const result = validateForm(form, eventFields);
      expect(result.valid).toBe(true);
    });
  });

  describe("phone ticket fields validation", () => {
    test("validates phone is required for phone-only events", () => {
      const fields = getTicketFields("phone");
      const form = new URLSearchParams({
        name: "John Doe",
        phone: "",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Your Phone Number is required");
      }
    });

    test("validates phone format for phone-only events", () => {
      const fields = getTicketFields("phone");
      const form = new URLSearchParams({
        name: "John Doe",
        phone: "abc",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Please enter a valid phone number");
      }
    });

    test("accepts valid phone for phone-only events", () => {
      const fields = getTicketFields("phone");
      const form = new URLSearchParams({
        name: "John Doe",
        phone: "+1 555 123 4567",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
    });

    test("validates both email and phone for both setting", () => {
      const fields = getTicketFields("both");
      const form = new URLSearchParams({
        name: "John Doe",
        email: "john@example.com",
        phone: "+1 555 123 4567",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(true);
    });

    test("rejects missing phone for both setting", () => {
      const fields = getTicketFields("both");
      const form = new URLSearchParams({
        name: "John Doe",
        email: "john@example.com",
        phone: "",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
    });

    test("rejects missing email for both setting", () => {
      const fields = getTicketFields("both");
      const form = new URLSearchParams({
        name: "John Doe",
        email: "",
        phone: "+1 555 123 4567",
      });
      const result = validateForm(form, fields);
      expect(result.valid).toBe(false);
    });
  });
});
