import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readCustomAuthorization } from "#shared/uptime-kuma/authorization.ts";

describe("readCustomAuthorization", () => {
  test("answers no authorization, valid, for a missing header string", () => {
    expect(readCustomAuthorization(null)).toEqual({
      authorization: null,
      valid: true,
    });
  });

  test("answers no authorization, valid, for an empty header string", () => {
    expect(readCustomAuthorization("")).toEqual({
      authorization: null,
      valid: true,
    });
  });

  test("reads the Authorization entry from the stored headers", () => {
    expect(readCustomAuthorization('{"Authorization": "Bearer abc"}')).toEqual({
      authorization: "Bearer abc",
      valid: true,
    });
  });

  test("finds the entry regardless of header name casing", () => {
    expect(readCustomAuthorization('{"authorization": "Basic xyz"}')).toEqual({
      authorization: "Basic xyz",
      valid: true,
    });
  });

  test("answers valid with no authorization when headers hold none", () => {
    expect(readCustomAuthorization('{"X-Custom": "yes"}')).toEqual({
      authorization: null,
      valid: true,
    });
  });

  test("answers invalid for a torn header string", () => {
    expect(readCustomAuthorization("{")).toEqual({
      authorization: null,
      valid: false,
    });
  });

  test("answers invalid for JSON that is not a string record", () => {
    expect(readCustomAuthorization("[1, 2]")).toEqual({
      authorization: null,
      valid: false,
    });
  });
});
