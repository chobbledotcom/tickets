import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square/api.ts";
import {
  installMockFetch,
  jsonResponse,
} from "#test/shared/square/mock-fetch.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { providerReadHttpCases } from "#test-utils/provider-failure-cases.ts";

const failedResponse = (status: number) => ({
  ok: false,
  status,
  text: () => Promise.resolve("failure"),
});

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

    test("reports invalid JSON as malformed provider data", async () => {
      installMockFetch(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("not-json"),
        }),
      );
      expect(await squareApi.readPayment("pay_json")).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
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

    test("reports a socket failure as a network outage", async () => {
      installMockFetch(() => Promise.reject(new TypeError("socket closed")));
      expect(await squareApi.readPayment("pay_network")).toEqual({
        reason: "network_error",
        status: "unavailable",
      });
    });

    test("does not disguise an internal transport failure as a network outage", async () => {
      installMockFetch(() => Promise.reject(new Error("transport bug")));
      await expect(squareApi.readPayment("pay_bug")).rejects.toThrow(
        "transport bug",
      );
    });

    for (const name of ["AbortError", "TimeoutError"]) {
      test(`reports ${name} as a timeout`, async () => {
        installMockFetch(() =>
          Promise.reject(new DOMException("timed out", name)),
        );
        expect(await squareApi.readPayment("pay_timeout")).toEqual({
          reason: "timeout",
          status: "unavailable",
        });
      });
    }
  });
});
