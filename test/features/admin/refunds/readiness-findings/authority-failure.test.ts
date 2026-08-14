/** Provider observations survive a later refund-authority storage failure. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { HeldRefundWork } from "#routes/admin/refunds/claim.ts";
import type { RefundRunDependencies } from "#routes/admin/refunds/provider.ts";
import type { RefundReadinessResult } from "#routes/admin/refunds/readiness.ts";
import { rememberReadinessFailureFindings } from "#routes/admin/refunds/readiness-findings.ts";
import { refreshClaimedPayment } from "#routes/admin/refunds/refresh.ts";
import {
  type ProviderRefundTarget,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import {
  candidate,
  canonicalTagged,
  heldClaim,
  provider as readyProvider,
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

type RefundAuthorityRequest = NonNullable<RefundRunDependencies["request"]>;

type FailedObservationRun = {
  readonly authorityRequests: readonly ProviderRefundTarget[];
  readonly claim: ReturnType<typeof grantingRowClaim>;
};

type StartedFailedObservationRun = FailedObservationRun & {
  readonly result: ReturnType<typeof refreshClaimedPayment>;
};

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

const requestAtStripe: RefundAuthorityRequest = (target) =>
  requestProviderRefund(target, {
    loadProvider: () => Promise.resolve(readyProvider("stripe")),
    now: () => Date.now(),
  });

const startFailedObservation = (
  refundCandidate: RefundCandidate,
  readiness: FailedReadiness,
  request: RefundAuthorityRequest = requestAtStripe,
): StartedFailedObservationRun => {
  const attendeeId = refundCandidate.attendee.id;
  const rows = refundCandidate.references.flatMap(
    ({ rowSessionIds }) => rowSessionIds,
  );
  const claim = grantingRowClaim(new Map([[attendeeId, rows]]));
  const authorityRequests: ProviderRefundTarget[] = [];
  const result = refreshClaimedPayment(refundCandidate, 3, {
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
  const observed = await canonicalTagged(
    "observed",
    "stripe",
    "observed_index",
  );
  const unread = await canonicalTagged("unread", "stripe", "unread_index");
  const run = startFailedObservation(
    candidate(9, [observed, unread]),
    failedAlongside(observed, charge),
  );
  await run.result;
  return run;
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
    candidate(9, [observed, unread]),
    failedAlongside(observed, fullyRefundedMoney()),
    request,
  );
};

const emptyHeldWork = (): HeldRefundWork => ({
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
});

describeWithEnv("failed refund evidence authority", { db: true }, () => {
  setupErrorSpy();

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

  test("keeps returned evidence when storing its authority fails", async () => {
    const reference = tagged("returned", "stripe", "returned_index");
    const refundCandidate = candidate(9, [reference]);
    const held = emptyHeldWork();

    await expect(
      rememberReadinessFailureFindings(
        [refundCandidate],
        failedAlongside(reference, fullyRefundedMoney()),
        held,
        () => Promise.reject(new Error("authority database failed")),
      ),
    ).rejects.toThrow("authority database failed");
    expect(held.findings.unrecorded).toEqual(
      new Map([[refundCandidate.attendee.id, reference.rowSessionIds]]),
    );
  });

  test("keeps every returned observation when a sibling authority fails", async () => {
    const returned = await canonicalTagged(
      "returned",
      "stripe",
      "returned_index",
    );
    const crashed = await canonicalTagged("crashed", "stripe", "crashed_index");
    const unread = await canonicalTagged("unread", "stripe", "unread_index");
    const refundCandidate = candidate(9, [returned, crashed, unread]);
    const readiness: FailedReadiness = {
      ...failedAlongside(returned, fullyRefundedMoney()),
      observations: [
        observationOf(returned, fullyRefundedMoney()),
        observationOf(crashed, fullyRefundedMoney()),
      ],
    };
    const held = emptyHeldWork();

    await expect(
      rememberReadinessFailureFindings(
        [refundCandidate],
        readiness,
        held,
        (target) =>
          target.reference.reference === returned.reference
            ? requestAtStripe(target)
            : Promise.reject(new Error("authority database failed")),
      ),
    ).rejects.toThrow("authority database failed");
    expect(held.findings.unrecorded).toEqual(
      new Map([
        [
          refundCandidate.attendee.id,
          [...returned.rowSessionIds, ...crashed.rowSessionIds],
        ],
      ]),
    );
  });
});
