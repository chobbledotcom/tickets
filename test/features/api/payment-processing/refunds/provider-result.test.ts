import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { providerRefundReturned } from "#routes/api/payment-processing/refunds.ts";
import type {
  ProviderRefundResult,
  RefundAuthorityReceipt,
} from "#shared/provider-refunds.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const reference = {
  kind: "tagged",
  provider: "stripe",
  reference: "pi_callback_result",
} as const;

const authority: RefundAuthorityReceipt = {
  id: 1,
  referenceIndex: "reference-index",
  revision: 2,
};

type ResultWithoutReference = ProviderRefundResult extends infer Answer
  ? Answer extends ProviderRefundResult ? Omit<Answer, "reference">
  : never
  : never;

const result = <Answer extends ResultWithoutReference>(
  answer: Answer,
): Answer & { readonly reference: typeof reference } => ({
  ...answer,
  reference,
});

describe("callback provider-refund result", () => {
  const errors = setupErrorSpy();

  it("calls only provider-proved returned money complete", () => {
    expect(
      providerRefundReturned(
        result({
          authority,
          kind: "returned",
          local: "due",
        }),
      ),
    ).toBe(true);
  });

  for (
    const pending of [
      { kind: "pending", state: "send_armed" },
      { kind: "pending", state: "observing" },
    ] as const
  ) {
    it(`keeps ${pending.state} money pending`, () => {
      expect(providerRefundReturned(result({ authority, ...pending }))).toBe(
        false,
      );
    });
  }

  it("reports a definitely unsent request that remains ready", () => {
    expect(
      providerRefundReturned(result({ authority, kind: "ready" }), {
        listingId: 7,
        provider: "stripe",
      }),
    ).toBe(false);
    expect(errors.contains("durable request remains ready")).toBe(true);
  });

  it("does not turn a read-only observation into a refund", () => {
    expect(
      providerRefundReturned(result({ kind: "unchanged" }), {
        listingId: 7,
        provider: "stripe",
      }),
    ).toBe(false);
    expect(errors.contains("only observed for stripe payment")).toBe(true);
  });

  it("reports an owner revision fence without claiming a refund", () => {
    expect(
      providerRefundReturned(result({ kind: "changed" }), {
        listingId: 7,
        provider: "stripe",
      }),
    ).toBe(false);
    expect(errors.contains("authority changed before")).toBe(true);
  });

  it("reports the exact reason an owner decision is required", () => {
    expect(
      providerRefundReturned(
        result({
          authority,
          kind: "needs_owner_choice",
          reason: "possibly_sent",
          requiresChoice: true,
        }),
      ),
    ).toBe(false);
    expect(errors.contains("possibly_sent")).toBe(true);
  });

  it("does not turn an unreadable provider answer into returned money", () => {
    expect(
      providerRefundReturned(
        result({
          admission: {
            kind: "read_failed",
            read: { reason: "network_error", status: "unavailable" },
          },
          kind: "withheld",
        }),
      ),
    ).toBe(false);
  });
});
