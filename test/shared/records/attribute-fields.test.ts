import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTRIBUTE_FIELDS } from "#shared/records/attribute-fields.ts";
import { fieldSpecList } from "#test-utils/fields.ts";

describe("the attribute fields", () => {
  test("hold the one name field", () => {
    expect(ATTRIBUTE_FIELDS).toEqual(fieldSpecList({ name: "name" }));
  });
});
