import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stripeMock } from "#shared/stripe/mock.ts";

describe("stripeMock.port", () => {
  test("uses the default only when the value is absent", () => {
    expect(stripeMock.port(undefined)).toBe(stripeMock.defaultPort);
  });

  for (const value of ["", "0", "0x10", "1junk", "65536"]) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expect(() => stripeMock.port(value)).toThrow(
        "STRIPE_MOCK_PORT must be a number from 1 to 65535",
      );
    });
  }

  test("accepts the full port range", () => {
    expect(stripeMock.port("1")).toBe(1);
    expect(stripeMock.port("65535")).toBe(65_535);
  });
});
