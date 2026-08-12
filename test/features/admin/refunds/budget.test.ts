import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  refundPreparedSubrequestCost,
  refundSubrequestCost,
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
): Extract<RefundPaymentReference, { kind: "tagged" }> => ({
  ...referenceFacts(provider),
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
  refundSubrequestCost(
    [{ references: [reference] }],
    new Set(),
    "before_claim",
    providers,
  ).external;

describe("admin refund subrequest budget", () => {
  test("gives every safe refusal checkpoint its remaining envelope", () => {
    const reference = taggedReference("stripe");
    const candidates = [{ references: [reference] }];

    expect(
      (["before_claim", "inside_claim", "before_provider_read"] as const).map(
        (checkpoint) =>
          refundSubrequestCost(candidates, new Set(), checkpoint, ["stripe"]),
      ),
    ).toEqual([
      { database: 20, external: 9, total: 29 },
      { database: 16, external: 9, total: 25 },
      { database: 5, external: 3, total: 8 },
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
      { database: 10, external: 0, total: 10 },
      { database: 5, external: 6, total: 11 },
    ]);
  });

  test("reserves the five local calls even when the provider already returned the money", () => {
    expect(
      refundPreparedSubrequestCost(
        { mayRecordReturns: true, sendReferences: [] },
        "before_dispatch_arm",
      ),
    ).toEqual({ database: 5, external: 0, total: 5 });
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
    ["stripe", 9],
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
    [["stripe"], 9],
    [["sumup"], 3],
    [["square", "stripe", "sumup"], 11],
  ] as const) {
    test(`counts ${calls} calls to discover an old reference through ${providers.length} providers`, () => {
      expect(externalCost(untaggedReference(), providers)).toBe(calls);
    });
  }
});
