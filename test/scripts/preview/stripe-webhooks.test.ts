import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { removeWebhooks } from "#scripts/preview/stripe-webhooks.ts";
import { type FakeStripe, fakeStripe } from "./fake-stripe.ts";

const HOSTS = ["site-1.bunny.run", "site-1.b-cdn.net"];
const MINE = "https://site-1.b-cdn.net/payment/webhook";
const OTHER = "https://other.b-cdn.net/payment/webhook";

const remove = (stripe: FakeStripe, hosts = HOSTS) =>
  removeWebhooks(
    { fetchText: stripe.fetchText, secretKey: "sk_test_x" },
    hosts,
  );

/** One delete against a fake account, and what it leaves. */
type Scenario = {
  expected: unknown;
  name: string;
  observe: (stripe: FakeStripe, result: unknown) => unknown;
  options?: Parameters<typeof fakeStripe>[1];
  urls: string[];
};

const SCENARIOS: Scenario[] = [
  {
    expected: {
      kept: [OTHER],
      result: {
        ok: true,
        value: ["Stripe webhook we_1", "Stripe webhook we_3"],
      },
    },
    name: "deletes the endpoints on either form of the host and keeps the others",
    observe: (stripe, result) => ({
      kept: [...stripe.endpoints.values()],
      result,
    }),
    urls: [MINE, OTHER, "https://site-1.bunny.run/payment/webhook"],
  },
  {
    expected: ["we_1", "we_2", "we_3"],
    name: "reads every page of endpoints",
    observe: (stripe) =>
      stripe.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.path.split("/").pop()),
    options: { pageSize: 1 },
    urls: [MINE, MINE, MINE],
  },
  {
    expected: { calls: 1, result: { ok: true, value: [] } },
    name: "deletes nothing when no endpoint is on the hosts",
    observe: (stripe, result) => ({ calls: stripe.calls.length, result }),
    urls: [OTHER],
  },
  {
    expected: ["Bearer sk_test_x"],
    name: "sends the secret key on every call",
    observe: (stripe) => [...new Set(stripe.calls.map((call) => call.auth))],
    urls: [MINE],
  },
  {
    expected: { ok: true, value: ["Stripe webhook we_1"] },
    name: "counts an endpoint that is already gone as deleted",
    observe: (_stripe, result) => result,
    options: { fails: { "DELETE /v1/webhook_endpoints/we_1": 404 } },
    urls: [MINE],
  },
];

const FAILURES: [string, Scenario["options"], string][] = [
  [
    "the endpoint list",
    { fails: { "GET /v1/webhook_endpoints": 401 } },
    "List Stripe webhooks failed (401): boom",
  ],
  [
    "an endpoint delete",
    { fails: { "DELETE /v1/webhook_endpoints/we_1": 500 } },
    "Delete Stripe webhook we_1 failed (500): boom",
  ],
];

describe("removeWebhooks", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const stripe = fakeStripe(scenario.urls, scenario.options);

      const result = await remove(stripe);

      expect(scenario.observe(stripe, result)).toEqual(scenario.expected);
    });
  }

  for (const [step, options, error] of FAILURES) {
    test(`stops and reports ${step}`, async () => {
      expect(await remove(fakeStripe([MINE], options))).toEqual({
        error,
        ok: false,
      });
    });
  }

  test("refuses an endpoint list that it cannot read", async () => {
    const result = await removeWebhooks(
      {
        fetchText: () =>
          Promise.resolve({ ok: true, status: 200, text: '{"data":[]}' }),
        secretKey: "sk_test_x",
      },
      HOSTS,
    );

    expect(result).toEqual({
      error: "List Stripe webhooks gave an answer this script cannot read.",
      ok: false,
    });
  });
});
