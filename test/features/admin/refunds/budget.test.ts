import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  REFUND_LEDGER_SUBREQUEST_RESERVE,
  REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
  refundPreparedSubrequestCost,
  refundReadinessSubrequestCost,
  subrequestCostFits,
} from "#routes/admin/refunds/budget.ts";
import type { TaggedRefundPaymentReference } from "#shared/db/payment-references.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import type { PaymentProviderType } from "#shared/types.ts";

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

const externalCost = (
  reference: TaggedRefundPaymentReference,
  providers: readonly PaymentProviderType[],
): number =>
  refundReadinessSubrequestCost(
    "refund",
    [{ references: [reference] }],
    new Set(),
    "before_claim",
    providers,
  ).external;

describe("admin refund subrequest budget", () => {
  test("prices no work when there are no candidates", () => {
    expect(
      refundReadinessSubrequestCost("refresh", [], new Set(), "before_claim", [
        "stripe",
      ]),
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
      database: 4,
      external: 0,
      total: 4,
    });
  });

  test("gives every safe refusal checkpoint its remaining envelope", () => {
    const reference = taggedReference("stripe");
    const candidates = [{ references: [reference] }];

    expect(
      (["before_claim", "inside_claim", "before_provider_read"] as const).map(
        (checkpoint) =>
          refundReadinessSubrequestCost(
            "refund",
            candidates,
            new Set(),
            checkpoint,
            ["stripe"],
          ),
      ),
    ).toEqual([
      { database: 30, external: 3, total: 33 },
      { database: 26, external: 1, total: 27 },
      { database: 24, external: 1, total: 25 },
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
      database: 24,
      external: 2,
      total: 26,
    });
  });

  test("prices each durable authority in a multi-charge command", () => {
    const references = [
      taggedReference("stripe", "stripe_deposit"),
      taggedReference("stripe", "stripe_balance"),
    ];
    expect(
      refundReadinessSubrequestCost(
        "refund",
        [{ references }],
        new Set(),
        "before_claim",
        ["stripe"],
      ),
    ).toEqual({ database: 50, external: 6, total: 56 });
  });

  test("reserves canonical lookup and ledger work for returned money", () => {
    expect(
      refundPreparedSubrequestCost(
        {
          activeAuthorityCount: 0,
          mayRecordReturns: true,
          returnedAuthorityCount: 1,
          sendReferences: [],
        },
      ),
    ).toEqual({ database: 8, external: 0, total: 8 });
  });

  test("reserves completed-only refresh persistence with no provider reads", () => {
    const completed = {
      ...taggedReference("stripe"),
      refundState: "completed" as const,
    };
    expect(
      refundReadinessSubrequestCost(
        "refresh",
        [{ references: [completed] }],
        new Set(),
        "before_claim",
        ["stripe"],
      ),
    ).toEqual({ database: 14, external: 0, total: 14 });
  });

  test("prices no late work when preparation can neither send nor return money", () => {
    expect(
      refundPreparedSubrequestCost(
        {
          activeAuthorityCount: 0,
          mayRecordReturns: false,
          returnedAuthorityCount: 0,
          sendReferences: [],
        },
      ),
    ).toEqual({ database: 0, external: 0, total: 0 });
  });

  for (
    const [provider, calls] of [
      ["square", 3],
      ["stripe", 3],
      ["sumup", 3],
    ] as const
  ) {
    test(`counts the full ${provider} read, send, and recovery plan`, () => {
      expect(externalCost(taggedReference(provider), [provider])).toBe(calls);
    });

    test(`counts no transport call when ${provider} is not configured`, () => {
      expect(
        externalCost(
          taggedReference(provider),
          PAYMENT_PROVIDER_IDS.filter((type) => type !== provider),
        ),
      ).toBe(0);
    });
  }
});
