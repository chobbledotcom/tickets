import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import {
  prepareRefundReadiness,
  type RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import { refundLedgerResult } from "#shared/refund-ledger/result.ts";
import type { ProviderRefundTarget } from "#shared/provider-refunds.ts";
import { requestRecordedProviderRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  found,
  heldClaim,
  stripeReadiness,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  gbp,
  partlyRefundedCharge,
  refundObservation,
  refundReference,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type FailedReadiness = Extract<
  RefundReadinessResult,
  { kind: "not_ready"; reason: "provider_evidence" }
>;

const failedAlongside = (
  reference: ReturnType<typeof tagged>,
  charge: FailedReadiness["observations"][number]["charge"],
): FailedReadiness => ({
  kind: "not_ready",
  observations: [{
    charge,
    identity: {
      kind: "tagged",
      provider: reference.provider,
      reference: reference.reference,
    },
    reference,
  }],
  reads: [
    {
      evidence: {
        attempts: [],
        provider: "stripe",
        reason: "timeout",
        reference: "unread",
        source: "tagged",
        status: "unavailable",
      },
      index: "unread_index",
    },
  ],
  reason: "provider_evidence",
});

type FailedObservationRun = {
  readonly authorityRequests: readonly ProviderRefundTarget[];
  readonly claim: ReturnType<typeof grantingRowClaim>;
};

const runFailedObservation = async (
  charge: FailedReadiness["observations"][number]["charge"],
): Promise<FailedObservationRun> => {
  const attendeeId = 9;
  const observed = tagged("observed", "stripe", "observed_index");
  const unread = tagged("unread", "stripe", "unread_index");
  const rows = [...observed.rowSessionIds, ...unread.rowSessionIds];
  const claim = grantingRowClaim(new Map([[attendeeId, rows]]));
  const authorityRequests: ProviderRefundTarget[] = [];
  await processRefundBatch(
    [
      {
        attendee: { id: attendeeId } as RefundCandidate["attendee"],
        references: [observed, unread],
      },
    ],
    3,
    {
      claim,
      prepare: () => Promise.resolve(failedAlongside(observed, charge)),
      request: (target, dependencies) => {
        authorityRequests.push(target);
        return requestRecordedProviderRefund(target, dependencies);
      },
    },
  );
  return { authorityRequests, claim };
};

const unresolvedDiscovery = (
  reference: ReturnType<typeof refundReference>,
  charge: FailedReadiness["observations"][number]["charge"],
): FailedReadiness => ({
  kind: "not_ready",
  observations: [],
  reads: [
    {
      evidence: {
        attempts: [
          {
            provider: "stripe",
            result: { resource: charge, status: "found" },
          },
          {
            provider: "square",
            result: { reason: "timeout", status: "unavailable" },
          },
        ],
        reason: "provider_search_incomplete",
        reference: reference.reference,
        source: "untagged",
        status: "unresolved",
      },
      index: reference.index,
    },
  ],
  reason: "provider_evidence",
});

const runUnresolvedDiscovery = async (
  charge: FailedReadiness["observations"][number]["charge"],
): Promise<ReturnType<typeof grantingRowClaim>> => {
  const attendeeId = 11;
  const reference = refundReference("ambiguous");
  const claim = grantingRowClaim(
    new Map([[attendeeId, reference.rowSessionIds]]),
  );
  await processRefundBatch(
    [
      {
        attendee: { id: attendeeId } as RefundCandidate["attendee"],
        references: [reference],
      },
    ],
    3,
    {
      claim,
      prepare: () => Promise.resolve(unresolvedDiscovery(reference, charge)),
    },
  );
  return claim;
};

const runPreparationCrash = async (
  reference: ReturnType<typeof refundReference>,
  record?: RefundRunDependencies["record"],
): Promise<ReturnType<typeof grantingRowClaim>> => {
  const attendeeId = 8;
  const claim = grantingRowClaim(
    new Map([[attendeeId, reference.rowSessionIds]]),
  );

  await expect(
    processRefundBatch(
      [
        {
          attendee: { id: attendeeId } as RefundCandidate["attendee"],
          references: [reference],
        },
      ],
      3,
      {
        claim,
        prepare: () => Promise.reject(new Error("provider read crashed")),
        ...(record === undefined ? {} : { record }),
      },
    ),
  ).rejects.toThrow("provider read crashed");

  return claim;
};

describe("admin refund readiness failure evidence", () => {
  setupErrorSpy();

  test("carries a returned sibling observation when another read fails", async () => {
    const returned = tagged("returned", "stripe", "returned_index");
    const unread = tagged("unread", "stripe", "unread_index");
    const result = await prepareRefundReadiness(
      [
        {
          attendee: { id: 7 } as RefundCandidate["attendee"],
          references: [returned, unread],
        },
      ],
      {
        ...heldClaim,
        held: new Map([
          [7, [...returned.rowSessionIds, ...unread.rowSessionIds]],
        ]),
        phases: new Map(
          [...returned.rowSessionIds, ...unread.rowSessionIds].map(
            (sessionId) => [sessionId, "checking" as const],
          ),
        ),
      },
      new Set(),
      stripeReadiness((reference) =>
        Promise.resolve(
          reference.reference === returned.reference
            ? found(reference, "stripe", fullyRefundedMoney())
            : {
              attempts: [
                {
                  provider: "stripe",
                  result: { reason: "timeout", status: "unavailable" },
                },
              ],
              provider: "stripe",
              reason: "timeout",
              reference: reference.reference,
              source: "tagged",
              status: "unavailable",
            },
        )
      ),
    );

    if (result.kind !== "not_ready" || result.reason !== "provider_evidence") {
      throw new Error("Expected incomplete provider evidence");
    }
    expect(result.observations).toEqual([{
      charge: fullyRefundedMoney(),
      identity: {
        kind: "tagged",
        provider: "stripe",
        reference: returned.reference,
      },
      reference: returned,
    }]);
  });

  test("protects a known return before readiness itself throws", async () => {
    const reference = refundReference("known_return", {
      refundState: "completed",
    });
    const claim = await runPreparationCrash(
      reference,
      (postings) =>
        Promise.resolve(
          new Map(
            postings.map(({ attendeeId, references }) => [
              attendeeId,
              refundLedgerResult(references),
            ]),
          ),
        ),
    );

    expect(claim.unrecorded).toEqual([reference.rowSessionIds]);
    expect(claim.released).toEqual([reference.rowSessionIds]);
  });

  test("releases the checking fence when readiness itself throws", async () => {
    const reference = refundReference("unread_throw");
    const claim = await runPreparationCrash(reference);

    expect(claim.released).toEqual([reference.rowSessionIds]);
    expect(claim.unrecorded).toEqual([[]]);
  });

  test("records a returned observation before releasing unread siblings", async () => {
    const run = await runFailedObservation(fullyRefundedMoney());

    expect(run.claim.released).toEqual([
      ["session_observed_index", "session_unread_index"],
    ]);
    expect(run.claim.unrecorded).toEqual([["session_observed_index"]]);
    expect(run.authorityRequests).toEqual([
      expect.objectContaining({ mode: "observe_only" }),
    ]);
  });

  test("gives a partial observation only to the provider authority", async () => {
    const run = await runFailedObservation(partlyRefundedCharge());

    expect(run.claim.released).toEqual([
      ["session_observed_index", "session_unread_index"],
    ]);
    expect(run.claim.reviewChanges).toEqual([new Map()]);
    expect(run.authorityRequests).toEqual([
      expect.objectContaining({ mode: "observe_only" }),
    ]);
  });

  test("does not turn a pending observation into an attendee-row hold", async () => {
    const run = await runFailedObservation(
      chargeMoneyWith({
        refunds: [refundObservation({ amount: gbp(100), status: "pending" })],
      }),
    );

    expect(run.claim.released).toEqual([
      ["session_observed_index", "session_unread_index"],
    ]);
    expect(run.claim.unrecorded).toEqual([[]]);
    expect(run.authorityRequests).toEqual([
      expect.objectContaining({ mode: "observe_only" }),
    ]);
  });

  test("releases clean evidence when only its sibling is unread", async () => {
    const run = await runFailedObservation(chargeMoney());

    expect(run.claim.released).toEqual([
      ["session_observed_index", "session_unread_index"],
    ]);
    expect(run.claim.unrecorded).toEqual([[]]);
    expect(run.claim.reviewChanges).toEqual([new Map()]);
    expect(run.authorityRequests).toEqual([]);
  });

  test("does not turn ambiguous provider evidence into an attendee-row hold", async () => {
    const claim = await runUnresolvedDiscovery(fullyRefundedMoney());

    expect(claim.released).toEqual([["sess_ambiguous"]]);
  });

  test("releases ambiguous legacy evidence when no provider saw money move", async () => {
    const claim = await runUnresolvedDiscovery(chargeMoney());

    expect(claim.released).toEqual([["sess_ambiguous"]]);
  });
});
