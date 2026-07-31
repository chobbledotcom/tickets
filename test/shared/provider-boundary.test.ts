import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  providerInstantSchema,
  StringMapSchema,
  sameMoney,
} from "#shared/provider-boundary.ts";

describe("provider response boundaries", () => {
  test("accepts only string maps", () => {
    expect(v.parse(StringMapSchema, { payment_id: "local-1" })).toEqual({
      payment_id: "local-1",
    });
    expect(() => v.parse(StringMapSchema, { payment_id: 1 })).toThrow();
  });

  test("keeps a valid provider instant unchanged by default", () => {
    const instant = "2026-07-26T13:00:00.000+01:00";
    expect(v.parse(providerInstantSchema("TestPay"), instant)).toBe(instant);
  });

  test("normalizes an instant when the provider boundary asks for it", () => {
    const schema = providerInstantSchema("TestPay", (value) =>
      new Date(value).toISOString(),
    );
    expect(v.parse(schema, "2026-07-26T13:00:00.000+01:00")).toBe(
      "2026-07-26T12:00:00.000Z",
    );
  });

  test("names the provider when rejecting an invalid instant", () => {
    expect(() =>
      v.parse(providerInstantSchema("TestPay"), "not-a-time"),
    ).toThrow("TestPay timestamp must be a real instant");
  });

  test("matches both parts of provider money", () => {
    const expected = { amount: 1_000, currency: "GBP" };
    expect(sameMoney(expected, { amount: 1_000, currency: "GBP" })).toBe(true);
    expect(sameMoney(expected, { amount: 999, currency: "GBP" })).toBe(false);
    expect(sameMoney(expected, { amount: 1_000, currency: "EUR" })).toBe(false);
  });
});
