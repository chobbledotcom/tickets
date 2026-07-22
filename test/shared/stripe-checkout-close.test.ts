import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

describe("Stripe hosted checkout closing", () => {
  const withStripeStatuses = (
    statuses: Array<{
      payment_status?: "paid" | "unpaid" | "no_payment_required";
      status: "complete" | "expired" | "open" | null;
    }>,
    expire: () => Promise<unknown>,
    body: (calls: {
      expire: () => number;
      retrieve: () => number;
    }) => void | Promise<void>,
  ) => {
    const retrieve = spy(() =>
      Promise.resolve(statuses.shift() ?? { status: null }),
    );
    const expireSpy = spy(expire);
    const client = {
      checkout: { sessions: { expire: expireSpy, retrieve } },
    };
    return withMocks(
      () =>
        stub(stripeClientRuntime, "get", () =>
          Promise.resolve(client as never),
        ),
      () =>
        body({
          expire: () => expireSpy.calls.length,
          retrieve: () => retrieve.calls.length,
        }),
    );
  };

  test("returns the Stripe session id as the provider checkout id", () =>
    withMocks(
      () =>
        stub(
          stripeApi,
          "createCheckoutSession",
          () =>
            Promise.resolve({
              id: "cs_123",
              url: "https://checkout.stripe.com/c/pay/cs_123",
            }) as never,
        ),
      async () => {
        expect(
          await stripePaymentProvider.createCheckoutSession(
            checkoutIntent(),
            "https://example.com",
          ),
        ).toEqual({
          checkoutUrl: "https://checkout.stripe.com/c/pay/cs_123",
          providerCheckoutId: "cs_123",
          sessionId: "cs_123",
        });
      },
    ));

  test("reports a successfully expired open session as closed", () =>
    withMocks(
      () =>
        stub(stripeApi, "closeCheckoutSession", () =>
          Promise.resolve("closed"),
        ),
      async (close) => {
        expect(
          await stripePaymentProvider.closeCheckout({
            providerCheckoutId: "cs_open",
            sessionId: "cs_open",
          }),
        ).toBe("closed");
        expect(close.calls[0]!.args).toEqual(["cs_open"]);
      },
    ));

  test("reports a completed session as paid", () =>
    withMocks(
      () =>
        stub(stripeApi, "closeCheckoutSession", () => Promise.resolve("paid")),
      async () => {
        expect(
          await stripePaymentProvider.closeCheckout({
            providerCheckoutId: "cs_complete",
            sessionId: "cs_complete",
          }),
        ).toBe("paid");
      },
    ));

  test("propagates a provider failure instead of claiming the checkout is closed", () =>
    withMocks(
      () =>
        stub(stripeApi, "closeCheckoutSession", () =>
          Promise.reject(new Error("Stripe unavailable")),
        ),
      async () => {
        await expect(
          stripePaymentProvider.closeCheckout({
            providerCheckoutId: "cs_unknown",
            sessionId: "cs_unknown",
          }),
        ).rejects.toThrow("Stripe unavailable");
      },
    ));

  test("expires an open Stripe session", () =>
    withStripeStatuses(
      [{ status: "open" }],
      () => Promise.resolve({}),
      async (calls) => {
        expect(await stripeApi.closeCheckoutSession("cs_open")).toBe("closed");
        expect(calls.retrieve()).toBe(1);
        expect(calls.expire()).toBe(1);
      },
    ));

  for (const [session, result] of [
    [{ payment_status: "paid", status: "complete" }, "paid"],
    [{ payment_status: "no_payment_required", status: "complete" }, "paid"],
    [{ status: "expired" }, "closed"],
  ] as const) {
    test(`returns ${result} without expiring a ${session.status} Stripe session`, () =>
      withStripeStatuses(
        [session],
        () => Promise.resolve({}),
        async (calls) => {
          expect(
            await stripeApi.closeCheckoutSession(`cs_${session.status}`),
          ).toBe(result);
          expect(calls.expire()).toBe(0);
        },
      ));
  }

  for (const [afterRace, result] of [
    [{ payment_status: "paid", status: "complete" }, "paid"],
    [{ status: "expired" }, "closed"],
  ] as const) {
    test(`returns ${result} when Stripe becomes ${afterRace.status} during expiry`, () =>
      withStripeStatuses(
        [{ status: "open" }, afterRace],
        () => Promise.reject(new Error("state changed")),
        async (calls) => {
          expect(await stripeApi.closeCheckoutSession("cs_race")).toBe(result);
          expect(calls.retrieve()).toBe(2);
        },
      ));
  }

  test("throws when Stripe still reports open after expiry fails", () =>
    withStripeStatuses(
      [{ status: "open" }, { status: "open" }],
      () => Promise.reject(new Error("network failed")),
      async () => {
        await expect(stripeApi.closeCheckoutSession("cs_open")).rejects.toThrow(
          "network failed",
        );
      },
    ));

  test("throws for an unknown Stripe lifecycle status", () =>
    withStripeStatuses(
      [{ status: null }],
      () => Promise.resolve({}),
      async () => {
        await expect(
          stripeApi.closeCheckoutSession("cs_unknown"),
        ).rejects.toThrow("Unknown Stripe checkout status");
      },
    ));

  test("throws when Stripe is not configured", () =>
    withMocks(
      () => stub(stripeClientRuntime, "get", () => Promise.resolve(null)),
      async () => {
        await expect(stripeApi.closeCheckoutSession("cs_none")).rejects.toThrow(
          "No Stripe client configured",
        );
      },
    ));

  test("reports a complete but unpaid Stripe session as closed", () =>
    withStripeStatuses(
      [{ payment_status: "unpaid", status: "complete" }],
      () => Promise.resolve({}),
      async () => {
        expect(await stripeApi.closeCheckoutSession("cs_unpaid")).toBe(
          "closed",
        );
      },
    ));
});
