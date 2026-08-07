import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  isSumupTransactionRefunded,
  SumupCheckoutResponseSchema,
  SumupTransactionResponseSchema,
} from "#shared/sumup/schemas.ts";
import { sumupSandboxFixture } from "#test-utils/sumup.ts";

describe("SumUp wire schemas", () => {
  for (const name of ["pending", "paid", "failed"] as const) {
    test(`parses the reviewed ${name} checkout`, async () => {
      const input = await sumupSandboxFixture(name);
      expect(v.parse(SumupCheckoutResponseSchema, input.response)).toEqual(
        input.response,
      );
    });
  }

  test("parses the reviewed refunded checkout and transaction", async () => {
    const input = await sumupSandboxFixture("refunded");
    expect(
      v.parse(SumupCheckoutResponseSchema, input.checkout_response),
    ).toEqual(input.checkout_response);
    const transaction = v.parse(
      SumupTransactionResponseSchema,
      input.transaction_response,
    );
    expect(transaction).toEqual(input.transaction_response);
    expect(isSumupTransactionRefunded(transaction)).toBe(true);
  });

  test("does not treat an incomplete refund total as fully refunded", async () => {
    const input = await sumupSandboxFixture("refunded");
    const transaction = v.parse(SumupTransactionResponseSchema, {
      ...(input.transaction_response as Record<string, unknown>),
      transaction_events: [
        { amount: 10, event_type: "REFUND", status: "REFUNDED" },
      ],
    });
    expect(isSumupTransactionRefunded(transaction)).toBe(false);
  });

  test("rejects a paid checkout without its named transaction", async () => {
    const input = await sumupSandboxFixture("paid");
    const checkout = input.response as Record<string, unknown>;
    delete checkout.transaction_id;
    expect(() => v.parse(SumupCheckoutResponseSchema, checkout)).toThrow();
  });

  test("rejects pending checkout facts on a paid checkout", async () => {
    const input = await sumupSandboxFixture("pending");
    expect(() =>
      v.parse(SumupCheckoutResponseSchema, {
        ...(input.response as Record<string, unknown>),
        status: "PAID",
      }),
    ).toThrow();
  });

  test("rejects an amount with more precision than its currency", async () => {
    const input = await sumupSandboxFixture("paid");
    expect(() =>
      v.parse(SumupCheckoutResponseSchema, {
        ...(input.response as Record<string, unknown>),
        amount: 23.456,
      }),
    ).toThrow();
  });
});
