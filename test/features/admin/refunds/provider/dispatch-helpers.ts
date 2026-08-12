import type { AuthorizeRefundDispatch } from "#routes/admin/refunds/attempt.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { armRefundDispatch } from "#shared/db/payment-refund-dispatch.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";

export const authorizeEveryRefund =
  (capability: RefundProviderCapability = "keyed"): AuthorizeRefundDispatch =>
  (indexes) =>
    Promise.resolve({
      kind: "armed",
      permits: new Map(
        indexes.map((index) => [
          index,
          {
            capability,
            commandId: "test-command",
            index,
            kind: "refund_dispatch" as const,
          },
        ]),
      ),
      phases: new Map(),
    });

export const armEveryRefund =
  (capability: RefundProviderCapability = "keyed"): typeof armRefundDispatch =>
  async ({ held, indexes }) => {
    const result = await authorizeEveryRefund(capability)(indexes);
    if (result.kind !== "armed") throw new Error("test dispatch was refused");
    return {
      ...result,
      phases: new Map(
        [...held.values()]
          .flat()
          .map((sessionId) => [sessionId, "send_armed" as const]),
      ),
    };
  };

export const reviewEveryArmedKeylessRefund =
  (): typeof armRefundDispatch =>
  async ({ indexes }) => ({
    indexes,
    kind: "owner_review",
    reason: "uncertain_keyless_refund",
  });

export const holdingClaim = (
  settle: RowClaim["settle"],
  sessions: readonly string[],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      commandId: "test-command",
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      inherited: new Map(),
      kind: "claimed",
      phases: new Map(sessions.map((sessionId) => [sessionId, "checking"])),
      returned: new Set<string>(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    }),
  settle,
});
