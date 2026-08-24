import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RefundCounts } from "#routes/admin/refunds/provider.ts";
import type {
  ProviderRefundResult,
  RefundAuthorityReceipt,
} from "#shared/provider-refunds.ts";
import {
  finishedCounts,
  processRefundBatchAt,
  provider,
  rowBackedCandidate,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const ATTENDEE_ID = 91;
const LISTING_ID = 7;
const SESSION_ID = "session_engine_outcome";

const RECEIPT: RefundAuthorityReceipt = {
  id: 1,
  referenceIndex: "index_engine_outcome",
  revision: 1,
};

type Reference = ProviderRefundResult["reference"];

/**
 * What the operator is told for each answer the refund engine can give.
 *
 * A `withheld` outcome is tallied as a failure, so the three answers that come
 * to "no money was sent" all reach the operator as one.
 */
const ANSWERS: ReadonlyArray<{
  readonly counts: Partial<RefundCounts>;
  readonly kind: ProviderRefundResult["kind"];
  readonly name: string;
  readonly result: (reference: Reference) => ProviderRefundResult;
}> = [
  {
    counts: { refundedCount: 1 },
    kind: "returned",
    name: "returned",
    result: (reference) => ({
      authority: RECEIPT,
      kind: "returned",
      local: "recorded",
      reference,
    }),
  },
  {
    counts: { pendingCount: 1 },
    kind: "pending",
    name: "pending",
    result: (reference) => ({
      authority: RECEIPT,
      kind: "pending",
      reference,
      state: "observing",
    }),
  },
  {
    counts: { pendingCount: 1 },
    kind: "needs_provider_check",
    name: "needs_provider_check",
    result: (reference) => ({
      authority: RECEIPT,
      kind: "needs_provider_check",
      reason: "provider_conflict",
      reference,
    }),
  },
  {
    counts: { pendingCount: 1 },
    kind: "needs_owner_choice",
    name: "needs_owner_choice, possibly_sent",
    result: (reference) => ({
      authority: RECEIPT,
      kind: "needs_owner_choice",
      reason: "possibly_sent",
      reference,
    }),
  },
  {
    counts: { failedCount: 1 },
    kind: "needs_owner_choice",
    name: "needs_owner_choice, provider_rejected",
    result: (reference) => ({
      authority: RECEIPT,
      kind: "needs_owner_choice",
      reason: "provider_rejected",
      reference,
    }),
  },
  {
    counts: { pendingCount: 1 },
    kind: "withheld",
    name: "withheld",
    result: (reference) => ({
      admission: {
        kind: "read_failed",
        read: { reason: "network_error", status: "unavailable" },
      },
      kind: "withheld",
      reference,
    }),
  },
  {
    counts: { failedCount: 1 },
    kind: "ready",
    name: "ready",
    result: (reference) => ({ authority: RECEIPT, kind: "ready", reference }),
  },
  {
    counts: { failedCount: 1 },
    kind: "changed",
    name: "changed",
    result: (reference) => ({ kind: "changed", reference }),
  },
  {
    counts: { failedCount: 1 },
    kind: "unchanged",
    name: "unchanged",
    result: (reference) => ({ kind: "unchanged", reference }),
  },
];

/** Every answer the engine can give. Growing `ProviderRefundResult` stops
 * this compiling until the new answer is listed, and the test below fails
 * until it also has a row in ANSWERS saying what the operator is told. */
const ANSWER_KINDS: Record<ProviderRefundResult["kind"], true> = {
  changed: true,
  needs_owner_choice: true,
  needs_provider_check: true,
  pending: true,
  ready: true,
  returned: true,
  unchanged: true,
  withheld: true,
};

const emptyCounts: RefundCounts = {
  failedCount: 0,
  notRecordedCount: 0,
  pendingCount: 0,
  refundedCount: 0,
};

const candidate = (): RefundCandidate =>
  rowBackedCandidate(ATTENDEE_ID, SESSION_ID);

describeWithEnv("refund engine answers", { db: true }, () => {
  setupErrorSpy();

  test("says what the operator is told for every answer", () => {
    expect(new Set(ANSWERS.map(({ kind }) => kind))).toEqual(
      new Set(Object.keys(ANSWER_KINDS)),
    );
  });

  for (const { counts, name, result } of ANSWERS) {
    test(`reports a ${name} answer`, async () => {
      const source = provider();

      expect(
        finishedCounts(
          await processRefundBatchAt(source, [candidate()], LISTING_ID, {
            claim: grantingRowClaim(new Map([[ATTENDEE_ID, [SESSION_ID]]])),
            record: recordEveryRefund,
            request: ({ reference }) => Promise.resolve(result(reference)),
          }),
        ),
      ).toEqual({ ...emptyCounts, ...counts });
    });
  }
});
