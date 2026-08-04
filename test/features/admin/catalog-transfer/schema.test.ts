import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ListingDataSchema } from "#routes/admin/catalog-transfer/schema.ts";

/** Parse a minimal listing whose `fields` is the value under test. */
const parseFields = (fields: string) =>
  v.safeParse(ListingDataSchema, { fields, maxAttendees: 1, name: "Thing" });

describe("ListingDataSchema fields", () => {
  test("trims whitespace around each field name", () => {
    const result = parseFields(" email , phone ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("email,phone");
  });

  test("drops repeated and trailing commas", () => {
    const result = parseFields("email,,phone,");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("email,phone");
  });

  test("accepts an empty fields list", () => {
    const result = parseFields("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("");
  });

  test("rejects an unknown contact field", () => {
    expect(parseFields("email,fax").success).toBe(false);
  });
});
