import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { readCreatedSumupCheckout } from "#shared/sumup/wire.ts";

describe("what SumUp answers a checkout creation with", () => {
  test("reads both fields a checkout needs to open", () => {
    expect(
      readCreatedSumupCheckout({
        hosted_checkout_url: "https://pay.sumup.com/x",
        id: "co_1",
      }),
    ).toEqual({ hosted_checkout_url: "https://pay.sumup.com/x", id: "co_1" });
  });

  test("leaves an absent field absent for the caller to judge", () => {
    // Which of the two a checkout cannot open without is the caller's rule,
    // not this parse's.
    expect(readCreatedSumupCheckout({ id: "co_1" })).toEqual({ id: "co_1" });
  });

  test("refuses an answer that is not a checkout at all", () => {
    let thrown: unknown;
    try {
      readCreatedSumupCheckout("co_1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderTransportError);
    expect((thrown as ProviderTransportError).facts).toEqual({
      malformed: true,
    });
  });

  test("refuses an answer whose id is not text", () => {
    expect(() => readCreatedSumupCheckout({ id: 7 })).toThrow(
      ProviderTransportError,
    );
  });
});
