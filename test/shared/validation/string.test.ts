import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  isNonEmptyString,
  type NonEmptyString,
  NonEmptyTextSchema,
  nonEmptyString,
  parseNonEmptyString,
  requiredTrimmedText,
  stringFields,
} from "#shared/validation/string.ts";

const acceptNonEmpty = (value: NonEmptyString): string => value;

describe("validation/string", () => {
  test("brands a non-empty string while keeping normal string behaviour", () => {
    const value = nonEmptyString("hello");
    expect(acceptNonEmpty(value)).toBe("hello");
    expect(value.toUpperCase()).toBe("HELLO");
  });

  test("parses and guards dynamic strings", () => {
    expect(parseNonEmptyString("file.webp")).toBe("file.webp");
    expect(parseNonEmptyString("")).toBeNull();
    expect(isNonEmptyString("file.webp")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
  });

  test("throws with the field name for invalid dynamic strings", () => {
    const empty: string = "";
    expect(() => nonEmptyString(empty, "image filename")).toThrow(
      "image filename must be non-empty",
    );
  });

  test("names the value when a caller supplies no field name", () => {
    const empty: string = "";
    expect(() => nonEmptyString(empty)).toThrow("value must be non-empty");
  });

  test("validates non-empty text without changing its string type", () => {
    expect(v.parse(NonEmptyTextSchema, "ticket-token")).toBe("ticket-token");
    expect(() => v.parse(NonEmptyTextSchema, "")).toThrow();
  });

  test("trims required text and refuses text that is only spaces", () => {
    expect(
      requiredTrimmedText("  ticket-token  ", "ticket-token is required"),
    ).toEqual({ ok: true, value: "ticket-token" });
    expect(requiredTrimmedText("   ", "ticket-token is required")).toEqual({
      error: "ticket-token is required",
      ok: false,
    });
  });

  test("makes one text field for each name, and no others", () => {
    const schema = v.object(stringFields("name", "url"));

    expect(Object.keys(schema.entries)).toEqual(["name", "url"]);
    expect(v.parse(schema, { name: "a", url: "b" })).toEqual({
      name: "a",
      url: "b",
    });
    expect(v.safeParse(schema, { name: "a", url: 1 }).success).toBe(false);
    expect(v.safeParse(schema, { name: "a" }).success).toBe(false);
  });
});
