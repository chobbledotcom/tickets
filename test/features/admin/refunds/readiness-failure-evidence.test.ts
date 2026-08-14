import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  processRefundBatch,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import { refundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  candidate,
  canonicalTagged,
  heldClaim,
  stripeReadiness,
  type tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { fullyRefundedMoney } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const runPreparationCrash = async (
  reference: ReturnType<typeof tagged>,
  record?: RefundRunDependencies["record"],
): Promise<ReturnType<typeof grantingRowClaim>> => {
  const attendeeId = 8;
  const claim = grantingRowClaim(
    new Map([[attendeeId, reference.rowSessionIds]]),
  );

  await expect(
    processRefundBatch([candidate(attendeeId, [reference])], 3, {
      claim,
      prepare: () => Promise.reject(new Error("provider read crashed")),
      ...(record === undefined ? {} : { record }),
    }),
  ).rejects.toThrow("provider read crashed");

  return claim;
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
      [candidate(7, [returned, unread])],
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
});
