import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundRequest } from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
  REFUND_PROVIDER_CAPABILITIES,
  type RefundAuthorization,
  requireProviderRefundAuthorization,
} from "#payment/refund-provider-authorization.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";

const request: RefundRequest = {
  charge: chargeMoney(),
  paymentReference: "provider_reference",
};

const keyedAuthorization = {
  capability: "keyed",
  generation: 1,
  idempotencyKey: "persisted-provider-key",
  identityIndex: "blind-request-index",
  provider: "stripe",
} as const satisfies RefundAuthorization<"stripe">;

describe("durable refund provider authorization", () => {
  test("mints one frozen provider-bound request", () => {
    const mutableAuthorization = {
      ...keyedAuthorization,
      idempotencyKey: String(keyedAuthorization.idempotencyKey),
    };
    const authorized = authorizeDurableRefundSend(
      request,
      mutableAuthorization,
    );
    mutableAuthorization.idempotencyKey = "tampered-after-arming";

    expect(authorized).toEqual({
      authorization: keyedAuthorization,
      ...request,
    });
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(Object.isFrozen(authorized.authorization)).toBe(true);
    expect(() =>
      requireProviderRefundAuthorization(authorized, "stripe"),
    ).not.toThrow();
  });

  test("refuses authority minted for another provider", () => {
    const authorized = authorizeDurableRefundSend(request, keyedAuthorization);

    expect(() =>
      requireProviderRefundAuthorization(authorized, "square"),
    ).toThrow("does not permit square");
  });

  for (const [name, authorization, message] of [
    [
      "zero generation",
      { ...keyedAuthorization, generation: 0 },
      "must be a positive safe integer",
    ],
    [
      "fractional generation",
      { ...keyedAuthorization, generation: 1.5 },
      "must be a positive safe integer",
    ],
    [
      "blank identity",
      { ...keyedAuthorization, identityIndex: "" },
      "identity index must not be blank",
    ],
    [
      "blank provider key",
      { ...keyedAuthorization, idempotencyKey: "" },
      "idempotency key must not be blank",
    ],
  ] as const) {
    test(`refuses a ${name}`, () => {
      expect(() => authorizeDurableRefundSend(request, authorization)).toThrow(
        message,
      );
    });
  }

  test("refuses a capability that contradicts its provider", () => {
    const contradictory = {
      capability: "keyless",
      generation: 1,
      identityIndex: "blind-request-index",
      provider: "stripe",
    } as unknown as RefundAuthorization<"stripe">;

    expect(() => authorizeDurableRefundSend(request, contradictory)).toThrow(
      "does not match its provider",
    );
  });

  test("declares every provider capability exhaustively", () => {
    expect(REFUND_PROVIDER_CAPABILITIES).toEqual({
      square: "keyed",
      stripe: "keyed",
      sumup: "keyless",
    });
  });
});

// @ts-expect-error Plain evidence has no durable send permit.
const unauthorized: AuthorizedRefundRequest = request;
const squareRequest = authorizeDurableRefundSend(request, {
  capability: "keyed",
  generation: 1,
  idempotencyKey: "square-key",
  identityIndex: "square-index",
  provider: "square",
});
// @ts-expect-error A Square authorization cannot be used as Stripe authority.
const wrongProvider: AuthorizedRefundRequest<"stripe"> = squareRequest;
void unauthorized;
void wrongProvider;
