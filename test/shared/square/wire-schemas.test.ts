import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  SquareOrderResponseSchema,
  SquarePaymentResponseSchema,
} from "#shared/square/schemas.ts";

describe("Square wire schemas", () => {
  test("retains order identity, location, and every tender payment", () => {
    const order = {
      created_at: "2026-08-07T10:00:00Z",
      id: "order-1",
      location_id: "location-1",
      metadata: { booking: "signed" },
      state: "COMPLETED",
      tenders: [
        { id: "tender-1", payment_id: "payment-1" },
        { id: "tender-2", payment_id: "payment-2" },
      ],
      total_money: { amount: 2500, currency: "GBP" },
    };
    expect(v.parse(SquareOrderResponseSchema, { order }).order).toEqual(order);
  });

  test("retains payment identity, parent, location, and money", () => {
    const payment = {
      amount_money: { amount: 2500, currency: "GBP" },
      id: "payment-1",
      location_id: "location-1",
      order_id: "order-1",
      refunded_money: { amount: 500, currency: "GBP" },
      status: "COMPLETED",
    };
    expect(v.parse(SquarePaymentResponseSchema, { payment }).payment).toEqual(
      payment,
    );
  });

  test("rejects malformed returned relationship fields", () => {
    expect(() =>
      v.parse(SquarePaymentResponseSchema, {
        payment: {
          id: "payment-1",
          location_id: 12,
          order_id: "order-1",
        },
      }),
    ).toThrow();
  });
});
