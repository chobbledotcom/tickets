import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { APIError, type SumUp } from "@sumup/sdk";
import * as v from "valibot";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupCheckoutSnapshot } from "#test/shared/sumup/fixtures.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";

const apiError = (status: number): APIError<unknown> =>
  new APIError(
    status,
    { status },
    new Response(null, { status, statusText: "SumUp test error" }),
  );

const withClient = (client: SumUp): Disposable =>
  stub(sumupApi, "getSumupClient", () => client);

describe("SumUp transport", () => {
  beforeEach(async () => {
    await createTestDb();
    setEffectiveDomainForTest("example.com");
    settings.setForTest({
      currency: "GBP",
      sumup_api_key: "sk_test_abc",
      sumup_merchant_code: "MC123",
    });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    resetDb();
  });

  test("validates every documented create success field", async () => {
    let request: Record<string, unknown> | undefined;
    using _client = withClient({
      checkouts: {
        create: (input: Record<string, unknown>) => {
          request = input;
          return Promise.resolve({
            amount: 10,
            checkout_reference: "sumup-local",
            currency: "GBP",
            date: "2026-07-26T12:00:00.000Z",
            hosted_checkout_url: "https://checkout.sumup.com/pay/co_created",
            id: "co_created",
            merchant_code: "MC123",
            status: "PENDING",
          });
        },
      },
    } as unknown as SumUp);

    await expect(
      sumupApi.createCheckout(await sumupCheckoutSnapshot()),
    ).resolves.toEqual({
      id: "co_created",
      reference: "sumup-local",
      url: "https://checkout.sumup.com/pay/co_created",
    });
    expect(request).toMatchObject({
      checkout_reference: "sumup-local",
      description: "Tickets (1 listing(s))",
    });
  });

  test("fails loudly for a malformed create success", async () => {
    using _client = withClient({
      checkouts: {
        create: () =>
          Promise.resolve({
            hosted_checkout_url: "https://checkout.sumup.com/pay/co_bad",
            id: "co_bad",
          }),
      },
    } as unknown as SumUp);

    await expect(
      sumupApi.createCheckout(await sumupCheckoutSnapshot()),
    ).rejects.toThrow(v.ValiError);
  });

  test("distinguishes a missing checkout from temporary unavailability", async () => {
    {
      using _client = withClient({
        checkouts: { get: () => Promise.reject(apiError(404)) },
      } as unknown as SumUp);
      await expect(
        sumupApi.retrieveCheckoutById("co_missing"),
      ).resolves.toEqual({
        status: "missing",
      });
    }
    {
      using _client = withClient({
        checkouts: { get: () => Promise.reject(new Error("network down")) },
      } as unknown as SumUp);
      await expect(sumupApi.retrieveCheckoutById("co_retry")).resolves.toEqual({
        status: "unavailable",
      });
    }
  });

  test("reports a failure that is not an error at all", async () => {
    // The SDK is not ours, so it can throw anything. Whatever it throws, the
    // read has to come back as unavailable rather than crashing the request.
    using _client = withClient({
      checkouts: {
        // deno-lint-ignore no-throw-literal
        get: () => Promise.reject("something odd"),
      },
    } as unknown as SumUp);

    await expect(sumupApi.retrieveCheckoutById("co_odd")).resolves.toEqual({
      status: "unavailable",
    });
  });

  test("returns a structured accepted refund without an invented id", async () => {
    const calls: unknown[][] = [];
    using _client = withClient({
      transactions: {
        refund: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve();
        },
      },
    } as unknown as SumUp);

    await expect(sumupApi.refundTransaction("txn_1")).resolves.toEqual({
      status: "accepted",
    });
    expect(calls).toEqual([["MC123", "txn_1"]]);
  });

  for (const [status, expected] of [
    [404, "missing"],
    [422, "rejected"],
  ] as const) {
    test(`classifies refund HTTP ${status} as ${expected}`, async () => {
      using _client = withClient({
        transactions: { refund: () => Promise.reject(apiError(status)) },
      } as unknown as SumUp);
      await expect(sumupApi.refundTransaction("txn_1")).resolves.toEqual({
        status: expected,
      });
    });
  }

  test("marks an ambiguous refund transport failure unavailable", async () => {
    using _client = withClient({
      transactions: {
        refund: () => Promise.reject(new Error("response lost")),
      },
    } as unknown as SumUp);
    await expect(sumupApi.refundTransaction("txn_1")).resolves.toEqual({
      status: "unavailable",
    });
  });
});
