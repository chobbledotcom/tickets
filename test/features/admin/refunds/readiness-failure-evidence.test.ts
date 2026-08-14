import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { HeldRefundWork } from "#routes/admin/refunds/claim.ts";
import {
  processRefundBatch,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import {
  prepareRefundReadiness,
  type RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import { rememberReadinessFailureFindings } from "#routes/admin/refunds/readiness-findings.ts";
import { refreshClaimedPayment } from "#routes/admin/refunds/refresh.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import {
  type ProviderRefundTarget,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { refundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  heldClaim,
  provider as readyProvider,
  stripeReadiness,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  fullyRefundedMoney,
  gbp,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type FailedReadiness = Extract<
  RefundReadinessResult,
  { kind: "not_ready"; reason: "provider_evidence" }
>;

const observationOf = (
  reference: ReturnType<typeof tagged>,
  charge: FailedReadiness["observations"][number]["charge"],
): FailedReadiness["observations"][number] => ({
  charge,
  identity: {
    kind: "tagged",
    provider: reference.provider,
    reference: reference.reference,
  },
  reference,
});

const failedAlongside = (
  reference: ReturnType<typeof tagged>,
  charge: FailedReadiness["observations"][number]["charge"],
): FailedReadiness => ({
  kind: "not_ready",
  observations: [observationOf(reference, charge)],
  reads: [
    {
      evidence: {
        provider: "stripe",
        reason: "timeout",
        reference: "unread",
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

type StartedFailedObservationRun = FailedObservationRun & {
  readonly result: ReturnType<typeof refreshClaimedPayment>;
};

type RefundAuthorityRequest = NonNullable<RefundRunDependencies["request"]>;

const requestAtStripe: RefundAuthorityRequest = (target) =>
  requestProviderRefund(target, {
    loadProvider: () => Promise.resolve(readyProvider("stripe")),
    now: () => Date.now(),
  });

const canonicalTagged = async (
  ...input: Parameters<typeof tagged>
): Promise<ReturnType<typeof tagged>> => {
  const reference = tagged(...input);
  const index = await paymentReferenceIndex(reference);
  return { ...reference, index, matchingIndexes: [index] };
};

const startFailedObservation = (
  candidate: RefundCandidate,
  readiness: FailedReadiness,
  request: RefundAuthorityRequest = requestAtStripe,
): StartedFailedObservationRun => {
  const attendeeId = candidate.attendee.id;
  const rows = candidate.references.flatMap(
    ({ rowSessionIds }) => rowSessionIds,
  );
  const claim = grantingRowClaim(new Map([[attendeeId, rows]]));
  const authorityRequests: ProviderRefundTarget[] = [];
  const result = refreshClaimedPayment(candidate, 3, {
    claim,
    prepare: () => Promise.resolve(readiness),
    request: (target, dependencies) => {
      authorityRequests.push(target);
      return request(target, dependencies);
    },
  });
  return { authorityRequests, claim, result };
};

const runFailedObservation = async (
  charge: FailedReadiness["observations"][number]["charge"],
): Promise<FailedObservationRun> => {
  const attendeeId = 9;
  const observed = await canonicalTagged(
    "observed",
    "stripe",
    "observed_index",
  );
  const unread = await canonicalTagged("unread", "stripe", "unread_index");
  const run = startFailedObservation(
    {
      attendee: { id: attendeeId } as RefundCandidate["attendee"],
      references: [observed, unread],
    },
    failedAlongside(observed, charge),
  );
  await run.result;
  return run;
};

const runPreparationCrash = async (
  reference: ReturnType<typeof tagged>,
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

const oneObservedFailure = async (
  request: RefundAuthorityRequest,
): Promise<StartedFailedObservationRun> => {
  const observed = await canonicalTagged(
    "observed",
    "stripe",
    "observed_index",
  );
  const unread = await canonicalTagged("unread", "stripe", "unread_index");
  return startFailedObservation(
    {
      attendee: { id: 9 } as RefundCandidate["attendee"],
      references: [observed, unread],
    },
    failedAlongside(observed, fullyRefundedMoney()),
    request,
  );
};

describeWithEnv("admin refund readiness failure evidence", { db: true }, () => {
  setupErrorSpy();

  test("carries a returned sibling observation when another read fails", async () => {
    const returned = await canonicalTagged(
      "returned",
      "stripe",
      "returned_index",
    );
    const unread = await canonicalTagged("unread", "stripe", "unread_index");
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
          reference === returned.reference
            ? { resource: fullyRefundedMoney(), status: "found" }
            : {
                reason: "timeout",
                status: "unavailable",
              },
        ),
      ),
    );

    if (result.kind !== "not_ready" || result.reason !== "provider_evidence") {
      throw new Error("Expected incomplete provider evidence");
    }
    expect(result.observations).toEqual([
      {
        charge: fullyRefundedMoney(),
        identity: {
          kind: "tagged",
          provider: "stripe",
          reference: returned.reference,
        },
        reference: returned,
      },
    ]);
  });

  test("protects a known return before readiness itself throws", async () => {
    const reference = await canonicalTagged(
      "known_return",
      "stripe",
      "known_return",
      "completed",
    );
    const claim = await runPreparationCrash(reference, (postings) =>
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
    const reference = await canonicalTagged(
      "unread_throw",
      "stripe",
      "unread_throw",
    );
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

  for (const [description, wrongReference] of [
    [
      "provider",
      {
        kind: "tagged",
        provider: "square",
        reference: "observed",
      },
    ],
    [
      "reference",
      { kind: "tagged", provider: "stripe", reference: "somewhere_else" },
    ],
  ] as const) {
    test(`refuses an authority answer for another ${description}`, async () => {
      const run = await oneObservedFailure(async (target) => ({
        ...(await requestAtStripe(target)),
        reference: wrongReference,
      }));

      await expect(run.result).rejects.toThrow(
        "Refund authority answered for a different payment",
      );
    });
  }

  test("refuses an authority answer that discards observed evidence", async () => {
    const run = await oneObservedFailure((target) =>
      Promise.resolve({ kind: "unchanged", reference: target.reference }),
    );

    await expect(run.result).rejects.toThrow(
      "Refund authority discarded observed refund evidence",
    );
  });

  test("records returned evidence before propagating a sibling authority failure", async () => {
    const returned = await canonicalTagged(
      "returned",
      "stripe",
      "returned_index",
    );
    const crashed = await canonicalTagged("crashed", "stripe", "crashed_index");
    const unread = await canonicalTagged("unread", "stripe", "unread_index");
    const candidate = {
      attendee: { id: 9 } as RefundCandidate["attendee"],
      references: [returned, crashed, unread],
    };
    const readiness: FailedReadiness = {
      ...failedAlongside(returned, fullyRefundedMoney()),
      observations: [
        observationOf(returned, fullyRefundedMoney()),
        observationOf(crashed, fullyRefundedMoney()),
      ],
    };
    const held: HeldRefundWork = {
      alreadyReturned: new Set(),
      claim: heldClaim,
      findings: {
        recorded: new Set(),
        reviews: new Map(),
        unrecorded: new Map(),
      },
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    };

    await expect(
      rememberReadinessFailureFindings(
        [candidate],
        readiness,
        held,
        (target) =>
          target.reference.reference === returned.reference
            ? requestAtStripe(target)
            : Promise.reject(new Error("authority database failed")),
      ),
    ).rejects.toThrow("authority database failed");
    expect(held.findings.unrecorded).toEqual(
      new Map([[candidate.attendee.id, returned.rowSessionIds]]),
    );
  });
});
