import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareRequestInit } from "#shared/square.ts";

describe("squareRequestInit", () => {
  test("builds the exact default GET request", () => {
    expect(squareRequestInit("square-token")).toEqual({
      headers: {
        Authorization: "Bearer square-token",
        "Content-Type": "application/json",
        "Square-Version": "2025-01-23",
      },
      method: "GET",
    });
  });

  test("keeps an empty method and serializes the JSON body", () => {
    expect(
      squareRequestInit("square-token", {
        body: { amount: BigInt(1250), reference: "order_123" },
        method: "",
      }),
    ).toEqual({
      body: '{"amount":1250,"reference":"order_123"}',
      headers: {
        Authorization: "Bearer square-token",
        "Content-Type": "application/json",
        "Square-Version": "2025-01-23",
      },
      method: "",
    });
  });
});
