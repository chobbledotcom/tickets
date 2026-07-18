import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withMessageGroups } from "#i18n";
import type { Field } from "#shared/forms/field.ts";
import { getModifierForm } from "#templates/fields/modifier.ts";

const calcValueField = (): Field => {
  const field = getModifierForm().fields.find(
    ({ name }) => name === "calc_value",
  );
  if (!field) throw new Error("calc_value field is missing");
  return field;
};

const fieldWith = (name: string): Field => {
  const field = getModifierForm().fields.find(
    (candidate) => candidate.name === name,
  );
  if (!field) throw new Error(`${name} field is missing`);
  return field;
};

const parseWith = (name: string, value: string): unknown => {
  const field = fieldWith(name);
  if (!field.parse) throw new Error(`${name} parser is missing`);
  return field.parse(value);
};

const validateWith = (name: string, value: string): string | null => {
  const field = fieldWith(name);
  if (!field.validate) throw new Error(`${name} validator is missing`);
  return field.validate(value);
};

describe("modifier fields", () => {
  test("defines the complete form", async () => {
    await withMessageGroups(["modifiers"], () => {
      const form = getModifierForm();
      expect(form.id).toBe("modifier");
      expect(JSON.parse(JSON.stringify(form.fields))).toEqual([
        {
          label: "Name",
          name: "name",
          placeholder: "Early bird",
          required: true,
          type: "text",
        },
        {
          defaultValue: "fixed",
          invalidMessage: "Invalid modifier type",
          label: "Type",
          name: "calc_kind",
          options: [
            { label: "Fixed amount", value: "fixed" },
            { label: "Percentage", value: "percent" },
            { label: "Multiplier", value: "multiply" },
          ],
          type: "select",
        },
        {
          defaultValue: "charge",
          invalidMessage: "Invalid direction",
          label: "Direction",
          name: "direction",
          options: [
            { label: "Charge (adds to the price)", value: "charge" },
            { label: "Discount (reduces the price)", value: "discount" },
          ],
          type: "select",
        },
        {
          hint: "Fixed: an amount in your currency. Percentage: e.g. 10 for 10%. Multiplier: e.g. 1.5. Direction is ignored for multipliers (the factor sets it).",
          inputmode: "decimal",
          label: "Value",
          name: "calc_value",
          required: true,
          type: "text",
        },
        {
          defaultValue: "automatic",
          hint: "When this applies. Promo codes are entered by the buyer at checkout; optional add-ons are chosen by the buyer; question answers apply when the buyer picks a linked answer (choose the answers on the edit page after saving).",
          invalidMessage: "Invalid trigger",
          label: "Trigger",
          name: "trigger",
          options: [
            { label: "Automatic (always)", value: "automatic" },
            { label: "Promo code", value: "code" },
            { label: "Optional add-on", value: "optional" },
            { label: "Question answer", value: "answer" },
          ],
          type: "select",
        },
        {
          hint: "The code buyers enter at checkout. Required for promo-code modifiers; ignored otherwise.",
          label: "Promo code",
          name: "code",
          placeholder: "SUMMER20",
          type: "text",
        },
        {
          defaultValue: "all",
          hint: "Which items this applies to. For specific listings or groups, choose the listings/groups on the edit page after saving.",
          invalidMessage: "Invalid scope",
          label: "Applies to",
          name: "scope",
          options: [
            { label: "The whole order", value: "all" },
            { label: "Specific listings", value: "listings" },
            { label: "Listings in specific groups", value: "groups" },
          ],
          type: "select",
        },
        {
          hint: "Only apply when the order subtotal is at least this amount (in your currency). Leave blank for no minimum.",
          inputmode: "decimal",
          label: "Minimum order (optional)",
          name: "min_subtotal",
          type: "text",
        },
        {
          hint: "Only apply to a returning customer with at least this many previous bookings. 0 (or blank) applies to everyone; 1 means seen at least once before.",
          label: "Minimum previous bookings (optional)",
          min: 0,
          name: "min_visits",
          type: "number",
        },
        {
          hint: "Total number available across all orders. Leave blank for unlimited.",
          label: "Stock (optional)",
          min: 0,
          name: "stock",
          type: "number",
        },
        {
          label: "Status",
          name: "active",
          options: [{ label: "Active (apply at checkout)", value: "1" }],
          type: "checkbox-group",
        },
      ]);
    });
  });

  test("rejects a number followed by junk", async () => {
    await withMessageGroups(["modifiers"], () => {
      const field = calcValueField();
      if (!field.validate) throw new Error("calc_value validator is missing");
      expect(field.validate("150abc")).toBe("Enter a valid number");
    });
  });

  test("parses a valid percentage", async () => {
    await withMessageGroups(["modifiers"], () => {
      const field = calcValueField();
      if (!field.parse) throw new Error("calc_value parser is missing");
      expect(field.parse("150")).toBe(150);
    });
  });

  test("parses and validates the optional minimum order", async () => {
    await withMessageGroups(["modifiers"], () => {
      expect(parseWith("min_subtotal", "")).toBe(0);
      expect(parseWith("min_subtotal", "5")).toBe(5);
      expect(validateWith("min_subtotal", "5")).toBeNull();
      expect(validateWith("min_subtotal", "not-money")).toBe(
        "Minimum order must be a valid amount for your currency",
      );
    });
  });

  test("parses the optional previous-booking count", async () => {
    await withMessageGroups(["modifiers"], () => {
      expect(parseWith("min_visits", "")).toBe(0);
      expect(parseWith("min_visits", "3")).toBe(3);
    });
  });
});
