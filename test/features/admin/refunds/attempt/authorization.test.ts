import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  finishPreparedCandidate,
  prepareReadyCandidate,
} from "#routes/admin/refunds/attempt.ts";
import type { RefundDispatchPermit } from "#shared/db/payment-refund-dispatch.ts";
import {
  provider,
  readyCandidateWithReferences,
} from "#test/features/admin/refunds/provider/helpers.ts";

const LISTING_ID = 7;

const prepareRefund = (paymentReference: string) => {
  const source = provider({ refunded: new Set([paymentReference]) });
  return {
    prepared: prepareReadyCandidate(
      readyCandidateWithReferences([paymentReference], source),
      LISTING_ID,
    ),
    source,
  };
};

const dispatchPermit = (
  index: string,
  changes: Partial<Pick<RefundDispatchPermit, "capability" | "index">> = {},
): RefundDispatchPermit => ({
  capability: "keyed",
  commandId: "test-command",
  index,
  kind: "refund_dispatch",
  ...changes,
});

describe("admin refund dispatch authorization", () => {
  test("fails closed when a ready refund has no dispatch decision", async () => {
    const { prepared, source } = prepareRefund("pi_no_decision");

    await expect(
      finishPreparedCandidate(await prepared, LISTING_ID, undefined),
    ).rejects.toThrow(
      "Refund index_of_stripe_pi_no_decision had no dispatch decision",
    );
    expect(source.refunds).toEqual([]);
  });

  test("moves no money after the claim changes during dispatch", async () => {
    const { prepared, source } = prepareRefund("pi_changed_claim");

    const result = await finishPreparedCandidate(await prepared, LISTING_ID, {
      kind: "claim_changed",
    });

    expect(result).toMatchObject({ outcome: "failed", returned: [] });
    expect(source.refunds).toEqual([]);
  });

  for (const [name, paymentReference, changes] of [
    [
      "another payment",
      "pi_wrong_index",
      { index: "index_of_stripe_pi_elsewhere" },
    ],
    ["another capability", "pi_wrong_capability", { capability: "keyless" }],
  ] as const) {
    test(`rejects a permit for ${name}`, async () => {
      const { prepared, source } = prepareRefund(paymentReference);
      const index = `index_of_stripe_${paymentReference}`;

      await expect(
        finishPreparedCandidate(await prepared, LISTING_ID, {
          kind: "armed",
          permits: new Map([[index, dispatchPermit(index, changes)]]),
          phases: new Map(),
        }),
      ).rejects.toThrow(
        `Refund dispatch permit does not match payment ${index}`,
      );
      expect(source.refunds).toEqual([]);
    });
  }
});
