import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { routePayment } from "#routes/api/webhooks.ts";
import { runWithRequestScopes } from "#routes/request-scopes.ts";
import {
  getSubrequestUsage,
  type SubrequestCounts,
} from "#shared/subrequest-budget.ts";
import {
  setupWithListing,
  signedMeta,
  stubCompletedSession,
  stubRefundOk,
} from "#test/lib/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";

const measuredWebhook = async (): Promise<{
  response: Response;
  usage: SubrequestCounts;
}> => {
  const request = mockWebhookRequest({}, { "stripe-signature": "sig_valid" });
  let usage: SubrequestCounts | null = null;
  const response = await runWithRequestScopes(request, undefined, async () => {
    const routed = await routePayment(request, "/payment/webhook", "POST");
    assert(routed !== null);
    usage = getSubrequestUsage();
    return routed;
  });
  if (usage === null) throw new Error("Webhook subrequest usage was not read");
  return { response, usage };
};

const withMeasuredWebhook = async (
  amount: number,
  id: string,
  itemPrice: number,
  use: (measured: Awaited<ReturnType<typeof measuredWebhook>>) => Promise<void>,
): Promise<void> => {
  const listing = await setupWithListing();
  const verify = await stubCompletedSession({
    amount_total: amount,
    id,
    metadata: signedMeta(amount, {
      items: singleItem(listing.id, 1, itemPrice),
    }),
  });
  try {
    await use(await measuredWebhook());
  } finally {
    verify.restore();
  }
};

describeWithEnv("payment callback database budget", { db: true }, () => {
  test("successful booking stays within callback headroom", async () => {
    await withMeasuredWebhook(
      1_000,
      "cs_success_budget",
      1_000,
      async (measured) => {
        expect(measured.response.status).toBe(200);
        expect(await measured.response.json()).toEqual({
          processed: true,
          received: true,
        });
        expect(measured.usage.database).toBe(18);
        expect(measured.usage.database).toBeLessThanOrEqual(40);
      },
    );
  });

  test("placeholder refund stays within callback headroom", async () => {
    const refund = stubRefundOk();
    try {
      await withMeasuredWebhook(
        999,
        "cs_refund_budget",
        999,
        async (measured) => {
          expect(measured.response.status).toBe(200);
          expect(await measured.response.json()).toEqual({
            processed: false,
            received: true,
            status: "fully_refunded",
          });
          expect(refund.calls).toHaveLength(1);
          expect(measured.usage.database).toBe(26);
          expect(measured.usage.database).toBeLessThanOrEqual(40);
        },
      );
    } finally {
      refund.restore();
    }
  });
});
