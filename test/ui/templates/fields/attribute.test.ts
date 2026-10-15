import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#templates/fields/attribute.ts";

describe("attribute editor forms", () => {
  test("the name form asks for an attribute name", () => {
    expect(attributeNameForm.fields[0]!.name).toBe("name");
    assertStringIncludes(attributeNameForm.render(), "Attribute name");
    assertStringIncludes(attributeNameForm.render(), "e.g. Difficulty");
  });

  test("the option form asks for option text", () => {
    expect(attributeOptionForm.fields[0]!.name).toBe("text");
    assertStringIncludes(attributeOptionForm.render(), "Option text");
    assertStringIncludes(attributeOptionForm.render(), "e.g. Beginner");
  });
});
