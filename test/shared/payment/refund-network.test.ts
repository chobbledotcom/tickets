import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import { refundPreparedSubrequestCost } from "#routes/admin/refunds/budget.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";

const retriesByProvider = (): Record<string, number> =>
  Object.fromEntries(
    PAYMENT_PROVIDER_IDS.map((id) => [id, REFUND_NETWORK_RETRIES[id]]),
  );

describe("transport retries inside one refund", () => {
  // A keyless provider pays twice when it is asked twice, and durable claims,
  // stable keys, and a fresh provider read own recovery for the rest. So the
  // rule is the same for every provider, and a new one has to say so here.
  test("gives every provider one attempt and no retry", () => {
    expect(retriesByProvider()).toEqual({ square: 0, stripe: 0, sumup: 0 });
  });

  test("prices one refund send as one attempt at the provider", () => {
    // A send and the recovery read that can follow it are two logical calls.
    // One attempt each is two provider calls; one retry would price four.
    for (const provider of PAYMENT_PROVIDER_IDS) {
      const cost = refundPreparedSubrequestCost({
        activeAuthorityCount: 1,
        mayRecordReturns: false,
        returnedAuthorityCount: 0,
        sendReferences: [{ index: "0", provider }],
      });

      expect(cost.external).toBe(2);
    }
  });
});
