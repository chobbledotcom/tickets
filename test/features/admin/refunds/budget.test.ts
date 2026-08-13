import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  REFUND_CALLER_SUBREQUEST_RESERVE,
  REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
  refundPreparedSubrequestCost,
  refundReadinessSubrequestCost,
  subrequestCostFits,
} from "#routes/admin/refunds/budget.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
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
): Extract<RefundPaymentReference, { kind: "tagged" }> => ({
  ...referenceFacts(label),
  kind: "tagged",
  provider,
});

const untaggedReference = (): RefundPaymentReference => ({
  ...referenceFacts("old"),
  kind: "untagged",
});

const externalCost = (
  reference: RefundPaymentReference,
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
    expect(REFUND_CALLER_SUBREQUEST_RESERVE).toEqual({
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
      { database: 28, external: 3, total: 31 },
      { database: 24, external: 3, total: 27 },
      { database: 5, external: 1, total: 6 },
    ]);
    const prepared = {
      mayRecordReturns: true,
      sendReferences: [
        { index: reference.index, provider: reference.provider },
      ],
    };
    expect(
      (["before_dispatch_arm", "before_provider_send"] as const).map(
        (checkpoint) => refundPreparedSubrequestCost(prepared, checkpoint),
      ),
    ).toEqual([
      { database: 10, external: 2, total: 12 },
      { database: 5, external: 2, total: 7 },
    ]);
  });

  test("admits the complete physical envelope for two ordinary Stripe charges", () => {
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
    ).toEqual({ database: 28, external: 6, total: 34 });
  });

  test("reserves the five local calls even when the provider already returned the money", () => {
    expect(
      refundPreparedSubrequestCost(
        { mayRecordReturns: true, sendReferences: [] },
        "before_dispatch_arm",
      ),
    ).toEqual({ database: 5, external: 0, total: 5 });
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
    ).toEqual({ database: 33, external: 0, total: 33 });
  });

  test("prices no late work when preparation can neither send nor return money", () => {
    expect(
      refundPreparedSubrequestCost(
        { mayRecordReturns: false, sendReferences: [] },
        "before_dispatch_arm",
      ),
    ).toEqual({ database: 0, external: 0, total: 0 });
  });

  for (const [provider, calls] of [
    ["square", 3],
    ["stripe", 3],
    ["sumup", 3],
  ] as const) {
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

  for (const [providers, calls] of [
    [[], 0],
    [["square"], 3],
    [["stripe"], 3],
    [["sumup"], 3],
    [["square", "stripe", "sumup"], 5],
  ] as const) {
    test(`counts ${calls} calls to discover an old reference through ${providers.length} providers`, () => {
      expect(externalCost(untaggedReference(), providers)).toBe(calls);
    });
  }
});
