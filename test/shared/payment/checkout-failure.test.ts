import { assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkoutErrorFrom,
  checkoutFailure,
  closedCheckoutErrorFor,
  type ProviderCheckoutError,
} from "#payment/checkout-failure.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";

const read = (error: ProviderCheckoutError) => ({
  message: error.message,
  provider: error.provider,
  reason: error.reason,
  statusCode: error.statusCode,
});

describe("what a checkout may say about a provider failure", () => {
  test("names a refusing provider by the status it answered with", () => {
    expect(read(checkoutErrorFrom("stripe", { statusCode: 402 }))).toEqual({
      message: "stripe checkout failed (provider_error:402)",
      provider: "stripe",
      reason: "provider_error",
      statusCode: 402,
    });
  });

  test("names a provider it could not reach by why", () => {
    expect(
      read(checkoutErrorFrom("sumup", { connectionReason: "timeout" })),
    ).toEqual({
      message: "sumup checkout failed (timeout)",
      provider: "sumup",
      reason: "timeout",
      statusCode: undefined,
    });
  });

  test("calls an answer it could not read unreadable, not a provider error", () => {
    // A provider that answers 502 with a broken body has still given us an
    // answer we cannot read, so the status must not hide that.
    expect(
      read(checkoutErrorFrom("square", { malformed: true, statusCode: 502 })),
    ).toEqual({
      message: "square checkout failed (invalid_response:502)",
      provider: "square",
      reason: "invalid_response",
      statusCode: 502,
    });
  });

  test("refuses to name a failure that carries no facts", () => {
    expect(() => checkoutErrorFrom("stripe", {})).toThrow(
      "stripe transport failure carries no facts",
    );
  });

  test("keeps every field the buyer's provider must never see out of the words", () => {
    const error = checkoutFailure.provider("stripe", 402);
    expect(error.name).toBe("ProviderCheckoutError");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("running one provider's checkout calls", () => {
  const closed = closedCheckoutErrorFor("sumup");

  test("closes a transport failure into provider facts", () => {
    const closedError = closed(
      transportError.answered(
        providerDetail.sumup(),
        409,
        "buyer private.person@example.com",
      ),
    );
    expect(read(closedError)).toEqual({
      message: "sumup checkout failed (provider_error:409)",
      provider: "sumup",
      reason: "provider_error",
      statusCode: 409,
    });
    expect(closedError.message).not.toContain("private.person@example.com");
  });

  test("lets a bug of ours keep travelling instead of blaming the provider", () => {
    const ours = new TypeError("a bug of ours");
    expect(assertThrows(() => closed(ours))).toBe(ours);
  });
});
