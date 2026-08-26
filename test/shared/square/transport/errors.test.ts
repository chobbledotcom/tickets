import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { settings } from "#db/settings.ts";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-fetch.ts";
import {
  ProviderTransportError,
  rejectedBuyerFieldOf,
} from "#payment/transport-error.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquareClient } from "#shared/square/client.ts";
import {
  installMockFetch,
  jsonResponse,
} from "#test/shared/square/mock-fetch.ts";
import { providerReadHttpCases } from "#test-utils/provider-failure-cases.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

const failedResponse = (status: number) => ({
  ok: false,
  status,
  text: () => Promise.resolve("failure"),
});

const thrownBy = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected Square transport to throw");
};

/** Read the transport failure one Square call raised. Anything else travels
 * on, so a test can never assert against a value the call did not produce. */
const transportFailureFrom = async (
  ask: (client: SquareClient) => Promise<unknown>,
): Promise<ProviderTransportError> => {
  const client = await squareApi.getSquareClient();
  if (!client) throw new Error("Square is not configured for this test");
  const thrown = await thrownBy(() => ask(client));
  if (thrown instanceof ProviderTransportError) return thrown;
  throw thrown;
};

const apiErrorFrom = (
  responseBody: string,
): Promise<ProviderTransportError> => {
  installMockFetch(() =>
    Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve(responseBody),
    }),
  );
  return transportFailureFrom((client) =>
    client.payments.get({ paymentId: "pay_error" }),
  );
};

describeSquare(() => {
  describe("Square payment transport outcomes", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      await settings.update.square.accessToken("EAAAl_transport_outcomes");
      await settings.update.square.sandbox(true);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    for (const [statusCode, expected] of providerReadHttpCases) {
      test(`keeps HTTP ${statusCode} distinct`, async () => {
        installMockFetch(() => Promise.resolve(failedResponse(statusCode)));
        expect(await squareApi.readPayment("pay_transport")).toEqual(expected);
      });
    }

    test("keeps an HTTP error body out of its message", async () => {
      const error = await apiErrorFrom(
        JSON.stringify({
          errors: [
            {
              category: "API_ERROR",
              code: "SERVER_ERROR",
              detail: "PRIVATE_REFERENCE",
            },
            {
              category: "INVALID_REQUEST_ERROR",
              code: "BAD_FIELD",
              field: "order.id",
            },
          ],
        }),
      );

      expect(error.message).toContain("Status code: 400");
      expect(error.message).not.toContain("PRIVATE_REFERENCE");
      expect(rejectedBuyerFieldOf(error)).toBeNull();
      expect("responseBody" in error).toBe(false);
    });

    for (const [providerField, invalidField] of [
      ["pre_populated_data.buyer_email", "email"],
      ["pre_populated_data.buyer_phone_number", "phone"],
    ] as const) {
      test(`retains only the safe ${invalidField} classification`, async () => {
        const error = await apiErrorFrom(
          JSON.stringify({
            errors: [
              {
                category: "INVALID_REQUEST_ERROR",
                code: "INVALID_VALUE",
                detail: "PRIVATE_REFERENCE",
                field: providerField,
              },
            ],
          }),
        );

        expect(rejectedBuyerFieldOf(error)).toBe(invalidField);
        expect(error.message).not.toContain("PRIVATE_REFERENCE");
        expect(error.message).not.toContain(providerField);
      });
    }

    test("keeps a malformed error payload unclassified", async () => {
      const error = await apiErrorFrom('{"errors":{}}');
      expect(rejectedBuyerFieldOf(error)).toBeNull();
    });

    test("discards malformed success bodies from its protocol error", async () => {
      const privateBody = "not-json-PRIVATE_REFERENCE";
      installMockFetch(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(privateBody),
        }),
      );
      const error = await transportFailureFrom((client) =>
        client.payments.get({ paymentId: "pay_json" }),
      );
      expect(error.message).not.toContain(privateBody);
    });

    test("reports a malformed payment body as malformed provider data", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({ payment: {} })));
      expect(await squareApi.readPayment("pay_shape")).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
    });

    test("reports a success response missing its payment as invalid", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));
      expect(await squareApi.readPayment("pay_absent_body")).toEqual({
        reason: "missing_documented_resource",
        status: "invalid",
      });
    });

    test("discards connection details from its network error", async () => {
      const privateDetail = "socket closed PRIVATE_REFERENCE";
      installMockFetch(() => Promise.reject(new TypeError(privateDetail)));
      const error = await transportFailureFrom((client) =>
        client.payments.get({ paymentId: "pay_network" }),
      );
      expect(error.facts.connectionReason).toBe("network_error");
      expect(error.message).not.toContain(privateDetail);
    });

    test("does not disguise an internal transport failure as a network outage", async () => {
      installMockFetch(() => Promise.reject(new Error("transport bug")));
      await expect(squareApi.readPayment("pay_bug")).rejects.toThrow(
        "transport bug",
      );
    });

    for (const name of ["AbortError", "TimeoutError"]) {
      test(`reports ${name} as a timeout`, async () => {
        const privateDetail = "timed out PRIVATE_REFERENCE";
        installMockFetch(() =>
          Promise.reject(new DOMException(privateDetail, name)),
        );
        const error = await transportFailureFrom((client) =>
          client.payments.get({ paymentId: "pay_timeout" }),
        );
        expect(error.facts.connectionReason).toBe("timeout");
        expect(error.message).not.toContain(privateDetail);
      });
    }

    test("gives up on a provider that never answers", async () => {
      using time = new FakeTime();
      const hangs = (...args: unknown[]): Promise<unknown> =>
        new Promise((_resolve, reject) => {
          const signal = (args[1] as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        });
      installMockFetch(hangs);
      const pending = squareApi.readPayment("pay_hang");
      await time.tickAsync(PROVIDER_TIMEOUT_MS);
      expect(await pending).toEqual({
        reason: "timeout",
        status: "unavailable",
      });
    });
  });
});
