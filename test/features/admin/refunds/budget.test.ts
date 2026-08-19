import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TaggedRefundPaymentReference } from "#db/payment-references.ts";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import {
  REFRESH_BUDGET_MESSAGE,
  REFUND_BUDGET_MESSAGES,
  REFUND_LEDGER_SUBREQUEST_RESERVE,
  REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
  refundPreparedSubrequestCost,
  refundReadinessSubrequestCost,
  subrequestCostFits,
} from "#routes/admin/refunds/budget.ts";
import type { PaymentProviderType } from "#types";

const referenceFacts = (label: string) => ({
  heldRowSessionIds: [],
  index: `index_${label}`,
  matchingIndexes: [`index_${label}`],
  reference: `payment_${label}`,
  refundState: "none" as const,
  rowSessionIds: [`session_${label}`] as [string],
  sessionIds: [`session_${label}`],
});

const taggedReference = (
  provider: PaymentProviderType,
  label: string = provider,
): TaggedRefundPaymentReference => ({
  ...referenceFacts(label),
  kind: "tagged",
  provider,
});

const externalCost = (reference: TaggedRefundPaymentReference): number =>
  refundReadinessSubrequestCost({
    action: "refund",
    candidates: [{ references: [reference] }],
    checkpoint: "before_claim",
    returned: new Set(),
  }).external;

const setSquareRetries = (retries: number): void => {
  Object.defineProperty(REFUND_NETWORK_RETRIES, "square", {
    configurable: true,
    enumerable: true,
    value: retries,
    writable: true,
  });
};

describe("admin refund subrequest budget", () => {
  test("keeps actionable guidance on every budget refusal", () => {
    expect(REFUND_BUDGET_MESSAGES).toEqual({
      bulk: "This run has too many payments to refund at once. Refund fewer attendees at a time.",
      single:
        "This attendee has too many payments to refund in one go. Refund them from the provider dashboard.",
    });
    expect(REFRESH_BUDGET_MESSAGE).toBe(
      "This attendee has too many payments to refresh safely in one request. No provider was contacted, and automatic refresh is unavailable for this payment set.",
    );
  });

  test("prices no work when there are no candidates", () => {
    expect(
      refundReadinessSubrequestCost({
        action: "refresh",
        candidates: [],
        checkpoint: "before_claim",
        returned: new Set(),
      }),
    ).toEqual({ database: 0, external: 0, total: 0 });
  });

  test("fits only when every provider and database allowance fits", () => {
    const cost = { database: 2, external: 3, total: 5 };
    expect(subrequestCostFits(cost, cost)).toBe(true);
    expect(
      [
        { database: 1, external: 3, total: 5 },
        { database: 2, external: 2, total: 5 },
        { database: 2, external: 3, total: 4 },
      ].map((remaining) => subrequestCostFits(cost, remaining)),
    ).toEqual([false, false, false]);
  });

  test("reserves database calls without inventing provider calls", () => {
    expect(REFUND_SETTLEMENT_SUBREQUEST_RESERVE).toEqual({
      database: 8,
      external: 0,
      total: 8,
    });
    expect(REFUND_LEDGER_SUBREQUEST_RESERVE).toEqual({
      database: 3,
      external: 0,
      total: 3,
    });
  });

  test("gives every safe refusal checkpoint its remaining envelope", () => {
    const reference = taggedReference("stripe");
    const candidates = [{ references: [reference] }];

    expect(
      (["before_claim", "inside_claim", "before_provider_read"] as const).map(
        (checkpoint) =>
          refundReadinessSubrequestCost({
            action: "refund",
            candidates,
            checkpoint,
            returned: new Set(),
          }),
      ),
    ).toEqual([
      { database: 17, external: 3, total: 20 },
      { database: 13, external: 1, total: 14 },
      { database: 11, external: 1, total: 12 },
    ]);
    const prepared = {
      activeAuthorityCount: 1,
      mayRecordReturns: true,
      returnedAuthorityCount: 0,
      sendReferences: [
        { index: reference.index, provider: reference.provider },
      ],
    };
    expect(refundPreparedSubrequestCost(prepared)).toEqual({
      database: 11,
      external: 2,
      total: 13,
    });
  });

  test("prices each durable authority in a multi-charge command", () => {
    const references = [
      taggedReference("stripe", "stripe_deposit"),
      taggedReference("stripe", "stripe_balance"),
    ];
    // A deposit-and-balance pair must fit a fresh request's 50-call budget.
    expect(
      refundReadinessSubrequestCost({
        action: "refund",
        candidates: [{ references }],
        checkpoint: "before_claim",
        returned: new Set(),
      }),
    ).toEqual({ database: 22, external: 6, total: 28 });
  });

  test("reserves canonical lookup and ledger work for returned money", () => {
    expect(
      refundPreparedSubrequestCost({
        activeAuthorityCount: 0,
        mayRecordReturns: true,
        returnedAuthorityCount: 1,
        sendReferences: [],
      }),
    ).toEqual({ database: 7, external: 0, total: 7 });
    expect(
      refundPreparedSubrequestCost({
        activeAuthorityCount: 0,
        mayRecordReturns: true,
        returnedAuthorityCount: 2,
        sendReferences: [],
      }),
    ).toEqual({ database: 8, external: 0, total: 8 });
  });

  test("reserves completed-only refresh persistence with no provider reads", () => {
    const completedReference = (label: string) => ({
      ...taggedReference("stripe", label),
      refundState: "completed" as const,
    });
    expect(
      refundReadinessSubrequestCost({
        action: "refresh",
        candidates: [{ references: [completedReference("stripe")] }],
        checkpoint: "before_claim",
        returned: new Set(),
      }),
    ).toEqual({ database: 13, external: 0, total: 13 });
    expect(
      refundReadinessSubrequestCost({
        action: "refresh",
        candidates: [
          {
            references: [
              completedReference("stripe_deposit"),
              completedReference("stripe_balance"),
            ],
          },
        ],
        checkpoint: "before_claim",
        returned: new Set(),
      }),
    ).toEqual({ database: 14, external: 0, total: 14 });
  });

  test("does not reserve returned-money recording twice before a refresh read", () => {
    expect(
      refundReadinessSubrequestCost({
        action: "refresh",
        candidates: [{ references: [taggedReference("stripe")] }],
        checkpoint: "before_provider_read",
        returned: new Set(),
      }),
    ).toEqual({ database: 10, external: 1, total: 11 });
  });

  test("prices no late work when preparation can neither send nor return money", () => {
    expect(
      refundPreparedSubrequestCost({
        activeAuthorityCount: 0,
        mayRecordReturns: false,
        returnedAuthorityCount: 0,
        sendReferences: [],
      }),
    ).toEqual({ database: 0, external: 0, total: 0 });
  });

  test("prices a live send even when it cannot record returned money", () => {
    expect(
      refundPreparedSubrequestCost({
        activeAuthorityCount: 1,
        mayRecordReturns: false,
        returnedAuthorityCount: 0,
        sendReferences: [{ index: "index_live", provider: "stripe" }],
      }),
    ).toEqual({ database: 11, external: 2, total: 13 });
  });

  test("multiplies logical provider work by every physical attempt", () => {
    const originalRetries = REFUND_NETWORK_RETRIES.square;
    setSquareRetries(1);
    try {
      expect(externalCost(taggedReference("square"))).toBe(6);
    } finally {
      setSquareRetries(originalRetries);
    }
  });

  for (const [provider, calls] of [
    ["square", 3],
    ["stripe", 3],
    ["sumup", 3],
  ] as const) {
    test(`prices the stored ${provider} identity without ambient configuration`, () => {
      expect(externalCost(taggedReference(provider))).toBe(calls);
    });
  }
});
