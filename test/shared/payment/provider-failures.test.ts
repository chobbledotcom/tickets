import { assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  providerFailure,
  providerFailureOf,
  requireProviderFailure,
  withExactRefundMoney,
} from "#payment/provider-failures.ts";
import type { RefundRequest } from "#payment/refund-attempt.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
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

describe("reading one caught provider error", () => {
  const valiError = (): unknown => {
    try {
      return v.parse(v.object({ id: v.string() }), { id: 7 });
    } catch (error) {
      return error;
    }
  };

  test("reads a transport error's own facts", () => {
    const error = transportError.answered(providerDetail.sumup(), 404);
    expect(providerFailureOf(error)?.read).toEqual({ status: "missing" });
  });

  test("reads a schema failure as an answer that broke its documented shape", () => {
    // The transport cannot see this one: the parse happens above it.
    expect(providerFailureOf(valiError())).toEqual({
      read: { reason: "malformed_response", status: "invalid" },
      refund: { kind: "uncertain", reason: "malformed_response" },
    });
  });

  test("claims nothing for an error the provider does not own", () => {
    expect(providerFailureOf(new Error("a bug of ours"))).toBeUndefined();
  });

  test("requiring a meaning lets our own bug keep travelling", () => {
    const ours = new Error("a bug of ours");
    expect(assertThrows(() => requireProviderFailure(ours))).toBe(ours);
  });

  test("requiring a meaning gives back the one the error proves", () => {
    expect(requireProviderFailure(valiError()).refund).toEqual({
      kind: "uncertain",
      reason: "malformed_response",
    });
  });
});

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
