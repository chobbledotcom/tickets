import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#templates/fields/attribute.ts";

describe("attribute editor forms", () => {
  test("the name form asks for an attribute name", () => {
    expect(attributeNameForm.fields[0]!.name).toBe("name");
    expect(attributeNameForm.render()).toContain("Attribute name");
    expect(attributeNameForm.render()).toContain("e.g. Difficulty");
  });

  test("the option form asks for option text", () => {
    expect(attributeOptionForm.fields[0]!.name).toBe("text");
    expect(attributeOptionForm.render()).toContain("Option text");
    expect(attributeOptionForm.render()).toContain("e.g. Beginner");
  });
});
