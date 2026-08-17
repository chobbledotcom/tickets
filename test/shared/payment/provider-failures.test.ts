import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  providerFailure,
  withExactRefundMoney,
} from "#shared/payment/provider-failures.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import { gbp } from "#test-utils/payment-state.ts";
import {
  providerReadHttpCases,
  providerRefundHttpCases,
} from "#test-utils/provider-failure-cases.ts";

const request: RefundRequest = {
  charge: {
    captured: gbp(1000),
    confirmedRefunded: gbp(0),
    refunds: [],
  },
  paymentReference: "charge_1",
};

describe("provider HTTP failures", () => {
  for (const [statusCode, expected] of providerReadHttpCases) {
    test(`classifies an HTTP ${statusCode} read`, () => {
      expect(providerFailure({ statusCode })?.read).toEqual(expected);
    });
  }

  for (const [statusCode, expected] of providerRefundHttpCases) {
    test(`classifies an HTTP ${statusCode} refund`, () => {
      expect(providerFailure({ statusCode })?.refund).toEqual(expected);
    });
  }

  test("preserves a named connection failure for both operations", () => {
    expect(providerFailure({ connectionReason: "network_error" })).toEqual({
      read: { reason: "network_error", status: "unavailable" },
      refund: { kind: "uncertain", reason: "network_error" },
    });
  });

  test("marks malformed answers invalid or uncertain", () => {
    expect(providerFailure({ malformed: true })).toEqual({
      read: { reason: "malformed_response", status: "invalid" },
      refund: { kind: "uncertain", reason: "malformed_response" },
    });
  });

  test("leaves unknown internal errors unclaimed", () => {
    expect(providerFailure({})).toBeUndefined();
  });
});

const readExactMoney = (parentId: string, amount: unknown, currency: unknown) =>
  withExactRefundMoney(request, parentId, amount, currency, (money) => ({
    money,
  }));

describe("withExactRefundMoney", () => {
  test("returns the exact admitted money", () => {
    expect(readExactMoney("charge_1", 1000, "gbp")).toEqual({
      money: gbp(1000),
    });
  });

  test("names a different parent", () => {
    expect(readExactMoney("charge_2", 1000, "GBP")).toEqual({
      kind: "uncertain",
      reason: "mismatched_parent",
    });
  });

  test("names malformed money", () => {
    expect(readExactMoney("charge_1", 1000, "pounds")).toEqual({
      kind: "uncertain",
      reason: "malformed_money",
    });
  });

  test("names a different amount", () => {
    expect(readExactMoney("charge_1", 999, "GBP")).toEqual({
      kind: "uncertain",
      reason: "mismatched_money",
    });
  });

  test("names a different currency", () => {
    expect(readExactMoney("charge_1", 1000, "USD")).toEqual({
      kind: "uncertain",
      reason: "mismatched_money",
    });
  });
});
