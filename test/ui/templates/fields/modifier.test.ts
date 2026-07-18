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

describe("modifier fields", () => {
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
});
