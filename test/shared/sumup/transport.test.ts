import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { createSumupTransport } from "#shared/sumup/transport.ts";

const realFetch = globalThis.fetch;

type FetchCall = { args: [string, RequestInit] };

const answerWith = (body: string, ok = true): { calls: FetchCall[] } => {
  const mock = spy((_url: string, _init: RequestInit) =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      text: () => Promise.resolve(body),
    }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock as unknown as { calls: FetchCall[] };
};

const asked = (calls: { calls: FetchCall[] }) => ({
  body: calls.calls[0]!.args[1].body,
  method: calls.calls[0]!.args[1].method,
  url: calls.calls[0]!.args[0],
});

const transport = createSumupTransport("sk_test_key");

const checkoutBody = {
  amount: 12.5,
  checkout_reference: "ref-1",
  currency: "GBP",
  description: "Tickets (1 listing(s))",
  hosted_checkout: { enabled: true },
  merchant_code: "MC1",
  redirect_url: "https://example.com/payment/success",
  return_url: "https://example.com/webhook",
};

describe("every call the app makes to SumUp", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("opens a checkout by posting the body SumUp needs", async () => {
    const calls = answerWith('{"id":"co_1"}');
    expect(await transport.createCheckout(checkoutBody)).toEqual({
      id: "co_1",
    });
    expect(asked(calls)).toEqual({
      body: JSON.stringify(checkoutBody),
      method: "POST",
      url: "https://api.sumup.com/v0.1/checkouts",
    });
  });

  test("reads one checkout by its id", async () => {
    const calls = answerWith('{"id":"co 1"}');
    expect(await transport.readCheckout("co 1")).toEqual({ id: "co 1" });
    expect(asked(calls)).toEqual({
      body: undefined,
      method: "GET",
      url: "https://api.sumup.com/v0.1/checkouts/co%201",
    });
  });

  test("reads the merchant the key belongs to", async () => {
    const calls = answerWith('{"merchant_profile":{}}');
    expect(await transport.readMerchant("MC/1")).toEqual({
      merchant_profile: {},
    });
    expect(asked(calls)).toEqual({
      body: undefined,
      method: "GET",
      url: "https://api.sumup.com/v1/merchants/MC%2F1",
    });
  });

  test("reads one transaction by id, under its merchant", async () => {
    const calls = answerWith('{"id":"txn 1"}');
    expect(await transport.readTransaction("MC1", { id: "txn 1" })).toEqual({
      id: "txn 1",
    });
    expect(asked(calls).url).toBe(
      "https://api.sumup.com/v2.1/merchants/MC1/transactions?id=txn%201",
    );
  });

  test("sends a refund with no body of its own", async () => {
    const calls = answerWith("");
    await transport.refundTransaction("MC1", "txn 1");
    expect(asked(calls)).toEqual({
      body: undefined,
      method: "POST",
      url: "https://api.sumup.com/v1.0/merchants/MC1/payments/txn%201/refunds",
    });
  });

  test("accepts a refund answer that carries a JSON envelope", async () => {
    answerWith('{"accepted":true}');
    await transport.refundTransaction("MC1", "txn_1");
  });

  test("refuses a refund answer it cannot read", async () => {
    answerWith("<html>nope</html>");
    // An unreadable envelope proves only that the POST may have landed.
    await expect(
      transport.refundTransaction("MC1", "txn_1"),
    ).rejects.toBeInstanceOf(ProviderTransportError);
  });

  test("carries the key on every call", async () => {
    const calls = answerWith("{}");
    await transport.readCheckout("co_1");
    const headers = calls.calls[0]!.args[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("keeps the status SumUp refused with", async () => {
    answerWith("gone", false);
    const error = await transport.readCheckout("co_1").catch((e) => e);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect((error as ProviderTransportError).facts).toEqual({
      statusCode: 500,
    });
  });
});
