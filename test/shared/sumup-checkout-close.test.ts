import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";

const METADATA = {
  _origin: "example.com",
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

describe("SumUp hosted checkout closing", () => {
  beforeEach(createTestDb);
  afterEach(resetDb);

  test("returns the SumUp checkout id separately from the local reference", () =>
    withMocks(
      () =>
        stub(sumupApi, "createCheckout", () =>
          Promise.resolve({
            id: "sumup_123",
            reference: "reference_123",
            url: "https://checkout.sumup.com/pay/sumup_123",
          }),
        ),
      async () => {
        expect(
          await sumupPaymentProvider.createCheckoutSession(
            {
              address: "",
              date: null,
              email: "alice@example.com",
              items: [],
              name: "Alice",
              phone: "",
              special_instructions: "",
            },
            "https://example.com",
          ),
        ).toEqual({
          checkoutUrl: "https://checkout.sumup.com/pay/sumup_123",
          providerCheckoutId: "sumup_123",
          sessionId: "reference_123",
        });
      },
    ));

  test("uses the locally stored SumUp id when only the session reference is available", async () => {
    await storeSumupCheckout("reference_open", METADATA);
    await setSumupCheckoutId("reference_open", "sumup_open");

    await withMocks(
      () =>
        stub(sumupApi, "closeCheckoutById", () => Promise.resolve("closed")),
      async (close) => {
        expect(
          await sumupPaymentProvider.closeCheckout({
            providerCheckoutId: "",
            sessionId: "reference_open",
          }),
        ).toBe("closed");
        expect(close.calls[0]!.args).toEqual(["sumup_open"]);
      },
    );
  });

  test("reports a naturally expired checkout as closed", () =>
    withMocks(
      () =>
        stub(sumupApi, "closeCheckoutById", () => Promise.resolve("closed")),
      async () => {
        expect(
          await sumupPaymentProvider.closeCheckout({
            providerCheckoutId: "sumup_expired",
            sessionId: "reference_expired",
          }),
        ).toBe("closed");
      },
    ));

  test("reports a completed checkout as paid", () =>
    withMocks(
      () => stub(sumupApi, "closeCheckoutById", () => Promise.resolve("paid")),
      async () => {
        expect(
          await sumupPaymentProvider.closeCheckout({
            providerCheckoutId: "sumup_paid",
            sessionId: "reference_paid",
          }),
        ).toBe("paid");
      },
    ));

  test("throws when neither source provides the provider checkout id", async () => {
    await expect(
      sumupPaymentProvider.closeCheckout({
        providerCheckoutId: "",
        sessionId: "missing_reference",
      }),
    ).rejects.toThrow("No SumUp checkout id for missing_reference");
  });

  const withSumupStatuses = (
    statuses: Array<"EXPIRED" | "FAILED" | "PAID" | "PENDING">,
    deactivate: () => Promise<unknown>,
    body: (calls: {
      deactivate: () => number;
      get: () => number;
    }) => void | Promise<void>,
  ) => {
    const get = spy(() =>
      Promise.resolve({
        amount: 10,
        checkout_reference: "reference",
        status: statuses.shift() ?? "PENDING",
      }),
    );
    const deactivateSpy = spy(deactivate);
    const client = { checkouts: { deactivate: deactivateSpy, get } };
    return withMocks(
      () => stub(sumupApi, "getSumupClient", () => client as never),
      () =>
        body({
          deactivate: () => deactivateSpy.calls.length,
          get: () => get.calls.length,
        }),
    );
  };

  test("deactivates a pending SumUp checkout", () =>
    withSumupStatuses(
      ["PENDING"],
      () => Promise.resolve({}),
      async (calls) => {
        expect(await sumupApi.closeCheckoutById("sumup_open")).toBe("closed");
        expect(calls.get()).toBe(1);
        expect(calls.deactivate()).toBe(1);
      },
    ));

  for (const [status, result] of [
    ["PAID", "paid"],
    ["EXPIRED", "closed"],
  ] as const) {
    test(`returns ${result} without deactivating a ${status} SumUp checkout`, () =>
      withSumupStatuses(
        [status],
        () => Promise.resolve({}),
        async (calls) => {
          expect(await sumupApi.closeCheckoutById("sumup")).toBe(result);
          expect(calls.deactivate()).toBe(0);
        },
      ));
  }

  for (const [afterRace, result] of [
    ["PAID", "paid"],
    ["EXPIRED", "closed"],
  ] as const) {
    test(`returns ${result} when SumUp becomes ${afterRace} during deactivation`, () =>
      withSumupStatuses(
        ["PENDING", afterRace],
        () => Promise.reject(new Error("state changed")),
        async () => {
          expect(await sumupApi.closeCheckoutById("sumup_race")).toBe(result);
        },
      ));
  }

  test("throws when SumUp still reports pending after deactivation fails", () =>
    withSumupStatuses(
      ["PENDING", "PENDING"],
      () => Promise.reject(new Error("network failed")),
      async () => {
        await expect(sumupApi.closeCheckoutById("sumup_open")).rejects.toThrow(
          "network failed",
        );
      },
    ));

  test("throws when SumUp is not configured", () =>
    withMocks(
      () => stub(sumupApi, "getSumupClient", () => null),
      async () => {
        await expect(sumupApi.closeCheckoutById("sumup_none")).rejects.toThrow(
          "No SumUp client configured",
        );
      },
    ));
});
