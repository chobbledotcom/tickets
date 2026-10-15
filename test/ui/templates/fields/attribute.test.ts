import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#templates/fields/attribute.ts";
import { says } from "#test-utils/says.ts";

describe("attribute editor forms", () => {
  test("the name form asks for an attribute name", () => {
    expect(attributeNameForm.fields[0]!.name).toBe("name");
    says(attributeNameForm.render(), "Attribute name");
    says(attributeNameForm.render(), "e.g. Difficulty");
  });

  test("the option form asks for option text", () => {
    expect(attributeOptionForm.fields[0]!.name).toBe("text");
    says(attributeOptionForm.render(), "Option text");
    says(attributeOptionForm.render(), "e.g. Beginner");
  });
});
