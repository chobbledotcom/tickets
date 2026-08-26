import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-fetch.ts";
import { sumupApi } from "#shared/sumup.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { setupSumupSuite } from "#test-utils/sumup.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const malformedJsonResponse = (status: number): Response =>
  new Response("{not json", {
    headers: { "content-type": "application/json" },
    status,
  });

describe("sumup transaction transport", () => {
  setupSumupSuite();

  test("reports a malformed successful checkout read as invalid", async () => {
    using _fetch = stubFetch(malformedJsonResponse(200));
    expect(await sumupApi.readCheckoutById("co_1")).toEqual({
      reason: "malformed_response",
      status: "invalid",
    });
  });

  test("reads the requested checkout with authenticated GET", async () => {
    using fetchStub = stubFetch(
      jsonResponse({
        amount: 10,
        checkout_reference: "ref",
        currency: "GBP",
        id: "co/one",
        merchant_code: "MC123",
        status: "PAID",
        transaction_id: "txn",
        transactions: [
          {
            amount: 10,
            currency: "GBP",
            id: "txn",
            merchant_code: "MC123",
            status: "SUCCESSFUL",
          },
        ],
      }),
    );
    expect(await sumupApi.readCheckoutById("co/one")).toEqual({
      resource: {
        amountMinor: 1000,
        currency: "GBP",
        reference: "ref",
        status: "PAID",
        transactionId: "txn",
      },
      status: "found",
    });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://api.sumup.com/v0.1/checkouts/co%2Fone");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer sk_test_abc",
    );
  });

  test("reads the requested transaction with authenticated GET", async () => {
    using fetchStub = stubFetch(
      jsonResponse({
        amount: 10,
        currency: "GBP",
        id: "txn/one",
        merchant_code: "MC123",
        status: "SUCCESSFUL",
      }),
    );
    expect(await sumupApi.readTransactionMoney("txn/one")).toEqual({
      resource: { amount: 10, currency: "GBP", refundEvents: [] },
      status: "found",
    });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe(
      "https://api.sumup.com/v2.1/merchants/MC123/transactions?id=txn%2Fone",
    );
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer sk_test_abc",
    );
  });

  test("reports a malformed successful read as invalid", async () => {
    using _fetch = stubFetch(malformedJsonResponse(200));
    expect(await sumupApi.readTransactionMoney("txn")).toEqual({
      reason: "malformed_response",
      status: "invalid",
    });
  });

  test("keeps a malformed HTTP 404 read authoritative", async () => {
    using _fetch = stubFetch(malformedJsonResponse(404));
    expect(await sumupApi.readTransactionMoney("txn")).toEqual({
      status: "missing",
    });
  });

  test("submits the requested refund with authenticated POST", async () => {
    using fetchStub = stubFetch(new Response(null, { status: 204 }));
    expect(await sumupApi.refundTransaction("txn/one")).toEqual({
      kind: "sent",
    });
    const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
    expect(url).toBe(
      "https://api.sumup.com/v1.0/merchants/MC123/payments/txn%2Fone/refunds",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer sk_test_abc",
    );
  });

  test("keeps a malformed successful refund uncertain", async () => {
    using _fetch = stubFetch(malformedJsonResponse(200));
    expect(await sumupApi.refundTransaction("txn")).toEqual({
      kind: "uncertain",
      reason: "malformed_response",
    });
  });

  test("keeps a malformed HTTP 422 refund authoritative", async () => {
    using _fetch = stubFetch(malformedJsonResponse(422));
    expect(await sumupApi.refundTransaction("txn")).toEqual({
      kind: "rejected",
      reason: "rejected",
    });
  });

  test("keeps an HTTP 409 refund uncertain until evidence can classify it", async () => {
    using _fetch = stubFetch(malformedJsonResponse(409));
    expect(await sumupApi.refundTransaction("txn")).toEqual({
      kind: "uncertain",
      reason: "provider_error",
    });
  });

  test("gives up on a provider that never answers", async () => {
    using time = new FakeTime();
    using _hangs = stub(
      globalThis,
      "fetch",
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal!.reason);
          });
        }),
    );
    const pending = sumupApi.refundTransaction("txn");
    await time.tickAsync(PROVIDER_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "uncertain", reason: "timeout" });
  });
});
