/** One shared boundary for unpacking a refund engine step. */

import type {
  ProviderRefundResult,
  ProviderRefundStep,
  ProviderRefundWork,
} from "#shared/provider-refunds.ts";

export type RefundWorkFacts = Pick<
  ProviderRefundWork,
  "admission" | "charge" | "now" | "row" | "target"
>;

type RefundWorkBody = (
  facts: RefundWorkFacts,
  work: ProviderRefundWork,
) => Promise<ProviderRefundResult>;

/** Give every engine step the same named facts and its untouched full work. */
export const withRefundWorkFacts =
  (body: RefundWorkBody): ProviderRefundStep =>
  (work) =>
    body(
      {
        admission: work.admission,
        charge: work.charge,
        now: work.now,
        row: work.row,
        target: work.target,
      },
      work,
    );
