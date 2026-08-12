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
      { database: 15, external: 9, total: 24 },
      { database: 11, external: 9, total: 20 },
      { database: 5, external: 3, total: 8 },
    ]);
    expect(
      (["before_dispatch_arm", "before_provider_send"] as const).map(
        (checkpoint) =>
          refundPreparedSubrequestCost(
            [{ index: reference.index, provider: reference.provider }],
            checkpoint,
          ),
      ),
    ).toEqual([
      { database: 5, external: 0, total: 5 },
      { database: 0, external: 6, total: 6 },
    ]);
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
