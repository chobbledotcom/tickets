import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ApiQuantitySchema,
  ChildrenSchema,
  PackageChildrenSchema,
} from "#routes/api/request-schemas.ts";

// deno-lint-ignore no-explicit-any
type Schema = any;

const parse = (schema: Schema, input: unknown) => v.safeParse(schema, input);
const accepts = (schema: Schema, input: unknown): boolean =>
  parse(schema, input).success;
const outputOf = (schema: Schema, input: unknown): unknown =>
  v.parse(schema, input);

describe("ApiQuantitySchema", () => {
  test("accepts positive integers as numbers or digit strings", () => {
    for (const input of [1, 2, 100, "2", "10"]) {
      expect(accepts(ApiQuantitySchema, input)).toBe(true);
    }
  });

  test("coerces a digit string to a number", () => {
    // The transform must run: "2" becomes the number 2, not the string "2".
    expect(outputOf(ApiQuantitySchema, "2")).toBe(2);
    expect(outputOf(ApiQuantitySchema, 3)).toBe(3);
  });

  test("rejects zero and negatives (minimum is 1)", () => {
    for (const input of [0, -1, -5, "0"]) {
      expect(accepts(ApiQuantitySchema, input)).toBe(false);
    }
  });

  test("rejects non-integer numbers", () => {
    for (const input of [1.5, 2.0001, 0.5]) {
      expect(accepts(ApiQuantitySchema, input)).toBe(false);
    }
  });

  test("rejects non-digit and empty strings", () => {
    for (const input of ["", "abc", "2.5", "2px", " 2"]) {
      expect(accepts(ApiQuantitySchema, input)).toBe(false);
    }
  });
});

describe("ChildrenSchema", () => {
  test("defaults an absent selection to an empty array", () => {
    expect(outputOf(ChildrenSchema, undefined)).toEqual([]);
    expect(outputOf(ChildrenSchema, null)).toEqual([]);
  });

  test("parses a minimal valid entry (slug + quantity)", () => {
    expect(outputOf(ChildrenSchema, [{ quantity: 2, slug: "gig" }])).toEqual([
      { quantity: 2, slug: "gig" },
    ]);
  });

  test("requires a non-empty slug", () => {
    expect(accepts(ChildrenSchema, [{ quantity: 2, slug: "" }])).toBe(false);
    expect(accepts(ChildrenSchema, [{ quantity: 2 }])).toBe(false);
  });

  test("validates each entry's quantity through the quantity rules", () => {
    expect(accepts(ChildrenSchema, [{ quantity: 0, slug: "gig" }])).toBe(false);
    expect(accepts(ChildrenSchema, [{ quantity: 1.5, slug: "gig" }])).toBe(
      false,
    );
  });

  test("accepts a customPrice of zero or more but rejects negative or non-finite", () => {
    expect(
      accepts(ChildrenSchema, [{ customPrice: 0, quantity: 1, slug: "g" }]),
    ).toBe(true);
    expect(
      accepts(ChildrenSchema, [{ customPrice: 12.5, quantity: 1, slug: "g" }]),
    ).toBe(true);
    expect(
      accepts(ChildrenSchema, [{ customPrice: -1, quantity: 1, slug: "g" }]),
    ).toBe(false);
    expect(
      accepts(ChildrenSchema, [
        { customPrice: Number.NaN, quantity: 1, slug: "g" },
      ]),
    ).toBe(false);
    expect(
      accepts(ChildrenSchema, [
        { customPrice: Number.POSITIVE_INFINITY, quantity: 1, slug: "g" },
      ]),
    ).toBe(false);
  });

  test("treats parent as optional (present when given, absent otherwise)", () => {
    expect(
      outputOf(ChildrenSchema, [{ parent: "pkg", quantity: 1, slug: "g" }]),
    ).toEqual([{ parent: "pkg", quantity: 1, slug: "g" }]);
    expect(accepts(ChildrenSchema, [{ quantity: 1, slug: "g" }])).toBe(true);
  });

  test("rejects an empty optional parent when it is present", () => {
    expect(
      accepts(ChildrenSchema, [{ parent: "", quantity: 1, slug: "g" }]),
    ).toBe(false);
  });
});

describe("PackageChildrenSchema", () => {
  test("requires a non-empty parent on every entry", () => {
    expect(
      accepts(PackageChildrenSchema, [
        { parent: "pkg", quantity: 1, slug: "g" },
      ]),
    ).toBe(true);
    // Missing or empty parent — the one field this schema adds over ChildrenSchema.
    expect(accepts(PackageChildrenSchema, [{ quantity: 1, slug: "g" }])).toBe(
      false,
    );
    expect(
      accepts(PackageChildrenSchema, [{ parent: "", quantity: 1, slug: "g" }]),
    ).toBe(false);
  });

  test("still defaults an absent selection to an empty array", () => {
    expect(outputOf(PackageChildrenSchema, undefined)).toEqual([]);
    expect(outputOf(PackageChildrenSchema, null)).toEqual([]);
  });

  test("still enforces the shared entry rules (slug, quantity)", () => {
    expect(
      accepts(PackageChildrenSchema, [
        { parent: "pkg", quantity: 0, slug: "g" },
      ]),
    ).toBe(false);
    expect(
      accepts(PackageChildrenSchema, [
        { parent: "pkg", quantity: 1, slug: "" },
      ]),
    ).toBe(false);
  });
});
