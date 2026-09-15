import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  parseJson,
  parseOrNull,
  parseOrThrow,
} from "#shared/validation/parse.ts";
import { thrownError } from "#test-utils/errors.ts";

const trimmedText = v.pipe(v.string(), v.trim());

const pointSchema = v.object({ x: v.number() });

describe("schema parsing", () => {
  test("returns a parsed value", () => {
    expect(
      parseOrThrow(trimmedText, " value ", () => new Error("invalid")),
    ).toBe("value");
  });

  test("throws the requested error for an invalid value", () => {
    const expected = new Error("invalid value");
    const error = thrownError(() =>
      parseOrThrow(trimmedText, 3, () => expected),
    );
    expect(error).toBe(expected);
  });

  test("returns null for an invalid value", () => {
    expect(parseOrNull(trimmedText, 3)).toBeNull();
  });
});

describe("parseJson", () => {
  test("reads JSON text and checks it against the schema", () => {
    expect(parseJson(pointSchema, '{"x": 2}')).toEqual({ x: 2 });
  });

  test("throws on text JSON cannot parse", () => {
    expect(() => parseJson(pointSchema, "{")).toThrow();
  });

  test("throws on JSON that is not the schema's shape", () => {
    expect(() => parseJson(pointSchema, '{"x": "two"}')).toThrow();
  });

  test("throws on non-JSON text that JSON almost reads", () => {
    expect(() => parseJson(pointSchema, "point")).toThrow();
  });
});
