import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { kindObject } from "#shared/validation/kind.ts";

describe("a choice that is only its own name", () => {
  const schema = kindObject("partial_refund");

  test("accepts the name it was made for", () => {
    expect(v.is(schema, { kind: "partial_refund" })).toBe(true);
  });

  test("refuses any other name", () => {
    expect(v.is(schema, { kind: "failed_refund" })).toBe(false);
  });

  test("refuses anything carried alongside the name", () => {
    // Strict, so an arm that grew a field cannot pass as the bare one and lose
    // whatever it was carrying.
    expect(v.is(schema, { kind: "partial_refund", reason: "late" })).toBe(
      false,
    );
  });
});
