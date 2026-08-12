import type { RefundRunDependencies } from "#routes/admin/refunds/provider.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

type RecordRefunds = NonNullable<RefundRunDependencies["record"]>;
type RefundReferences = Parameters<RecordRefunds>[0][number]["references"];

const recordWith = (
  resultFor: (references: RefundReferences) => RefundLedgerResult,
): RecordRefunds =>
(attendees) =>
  Promise.resolve(
    new Map(
      [...Map.groupBy(attendees, ({ attendeeId }) => attendeeId)].map(
        ([attendeeId, postings]) => [
          attendeeId,
          resultFor(postings.flatMap(({ references }) => references)),
        ],
      ),
    ),
  );

/** A ledger mock that records every returned reference. */
export const recordEveryRefund: RecordRefunds = recordWith((references) =>
  refundLedgerResult(references)
);

/** A ledger mock that cannot record any returned reference. */
export const recordNoRefunds: RecordRefunds = recordWith((references) =>
  refundLedgerResult([], references)
);
