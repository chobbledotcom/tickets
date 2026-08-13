/* jscpd:ignore-start -- imports */
import { uniqueBy } from "#fp";
import { nowMs } from "#shared/now.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  type ProviderRefundResult,
  type RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import type { ReadyRefundReference } from "./readiness.ts";
/* jscpd:ignore-end */

/** Ask the sole refund authority using evidence readiness already proved. */
export const requestReadyRefund = (
  ready: ReadyRefundReference,
  mode: "observe_only" | "send",
  request: typeof requestProviderRefund,
): Promise<ProviderRefundResult> =>
  request(
    {
      evidence: ready.kind === "observed"
        ? { charge: ready.charge, kind: "observed" }
        : { kind: "returned_marker" },
      mode,
      reference: ready.reference,
    },
    {
      loadProvider: () => Promise.resolve(ready.provider),
      now: nowMs,
    },
  );

export interface AuthorityBearingReference<
  TReference extends { readonly index: string } = {
    readonly index: string;
  },
> {
  readonly authority: RefundAuthorityReceipt | null;
  readonly reference: TReference;
}

/** Keep only authorities whose exact reference reached the local ledger. */
export const recordedRefundAuthorities = (
  references: readonly AuthorityBearingReference[],
  ledger: Pick<RefundLedgerResult, "recorded">,
): RefundAuthorityReceipt[] =>
  uniqueBy((authority: RefundAuthorityReceipt) => authority.id)(
    references.flatMap(({ authority, reference }) =>
      authority !== null && ledger.recorded.has(reference.index)
        ? [authority]
        : []
    ),
  );
