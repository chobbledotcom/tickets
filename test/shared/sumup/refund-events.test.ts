import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { SumUp } from "@sumup/sdk";
import { sumupApi } from "#shared/sumup.ts";
import {
  describeSumup,
  stubSumupClient,
  sumupTransactionResource,
  sumupTransactionResponse,
} from "#test/shared/sumup/fixtures.ts";

/** Read the transaction SumUp reports, with these events on it. */
const readWithEvents = (events: Record<string, unknown>[]) => {
  using _client = stubSumupClient({
    transactions: {
      get: () =>
        Promise.resolve(
          sumupTransactionResponse({
            id: sumupTransactionResource.id,
            transaction_events: events,
          }),
        ),
    },
  } as unknown as SumUp);
  return sumupApi.getTransactionStatus(sumupTransactionResource.id);
};

describeSumup("what SumUp's transaction events say about refunds", () => {
  test("ignores an event that is not about a refund", async () => {
    const read = await readWithEvents([
      { amount: 10, event_type: "PAYOUT", id: 1, status: "PAID_OUT" },
    ]);

    expect(read).toMatchObject({
      status: "found",
      value: { refunded: { amount: 0, currency: "GBP" }, refunds: [] },
    });
  });

  test("records a refund that has no id or time of its own", async () => {
    const read = await readWithEvents([
      { amount: 4, event_type: "REFUND", status: "REFUNDED" },
    ]);

    expect(read).toEqual({
      status: "found",
      value: {
        amount: { amount: 1_000, currency: "GBP" },
        id: sumupTransactionResource.id,
        merchantCode: "MC123",
        refunded: { amount: 400, currency: "GBP" },
        refunds: [
          { amount: { amount: 400, currency: "GBP" }, status: "completed" },
        ],
        status: "SUCCESSFUL",
        timestamp: "2026-07-26T12:01:00.000Z",
      },
    });
  });

  test("cannot answer about a refund reported in a state we do not know", async () => {
    // Reading refuses the unknown state, and the refusal reaches the caller as
    // "we cannot answer right now" — see TODO.md, which records that this
    // leaves the read being asked again for ever.
    expect(
      await readWithEvents([
        { amount: 4, event_type: "REFUND", id: 2, status: "SCHEDULED" },
      ]),
    ).toEqual({ status: "unavailable" });
  });
});
