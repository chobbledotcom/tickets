import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  REFUND_BUDGET_MESSAGES,
  REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
} from "#routes/admin/refunds/budget.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { settings } from "#shared/db/settings.ts";
import { REFUND_NETWORK_RETRIES } from "#shared/payment/refund-network.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { requestRecordedProviderRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  prepareAtProvider,
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

const taggedReference = (
  attendeeId: number,
  offset: number,
  refundState: RefundPaymentReference["refundState"] = "none",
  paymentProvider: TaggedReference["provider"] = "stripe",
): TaggedReference => {
  const reference = `pi_budget_${attendeeId}_${offset}`;
  const index = `index_of_${paymentProvider}_${reference}`;
  const sessionId = `session_${reference}`;
  return {
    heldRowSessionIds: [],
    index,
    kind: "tagged",
    matchingIndexes: [index],
    provider: paymentProvider,
    reference,
    refundState,
    rowSessionIds: [sessionId],
    sessionIds: [sessionId],
  };
};

const candidate = (
  attendeeId: number,
  referenceCount: number,
  refundState: RefundPaymentReference["refundState"] = "none",
  paymentProvider: TaggedReference["provider"] = "stripe",
) => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: Array.from(
    { length: referenceCount },
    (_, offset) =>
      taggedReference(attendeeId, offset, refundState, paymentProvider),
  ),
});

const expectRefusedBeforeClaim = async (
  candidates: RefundCandidate[],
): Promise<void> => {
  await settings.update.stripe.secretKey("sk_test_budget");
  const source = provider();
  let claims = 0;
  const granted = grantingRowClaim();
  const result = await processRefundBatchAt(source, candidates, 7, {
    claim: {
      claim: (attendees) => {
        claims++;
        return granted.claim(attendees);
      },
      settle: granted.settle,
    },
    record: recordEveryRefund,
  });

  expect(result).toMatchObject({
    kind: "not_ready",
    message: REFUND_BUDGET_MESSAGES.bulk,
    reason: "subrequest_budget",
  });
  expect(claims).toBe(0);
  expect(source.reads).toEqual([]);
  expect(source.refunds).toEqual([]);
};

const expectBudgetRefusal = (result: unknown): void => {
  expect(result).toMatchObject({
    kind: "not_ready",
    reason: "subrequest_budget",
  });
};

describeWithEnv(
  "admin refund provider > whole-command budget",
  { db: true },
  () => {
    test("three Stripe payments on one attendee make zero provider calls", async () => {
      await expectRefusedBeforeClaim([candidate(11, 3)]);
    });

    test("a provider set beyond Bunny's total limit refuses before its first send", async () => {
      const candidates = Array.from(
        { length: 9 },
        (_, offset) => candidate(20 + offset, 1),
      );
      await expectRefusedBeforeClaim(candidates);
    });

    test("the single-attendee surface gives its own dashboard guidance", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const result = await processRefundBatchAt(source, [candidate(30, 9)], 7, {
        audience: "single",
        claim: grantingRowClaim(),
      });

      expect(result).toMatchObject({
        kind: "not_ready",
        message: REFUND_BUDGET_MESSAGES.single,
        reason: "subrequest_budget",
      });
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
    });

    test("the claim transaction rejects an exact set that became too large", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const grant = grantingRowClaim();
      let settlements = 0;
      const raceClaim: RowClaim = {
        claim: (attendees, admit) => {
          if (admit === undefined) throw new Error("No exact budget admission");
          const raced = [
            ...attendees,
            ...Array.from({ length: 10 }, (_, offset) => ({
              attendeeId: 41 + offset,
              loadedPiiBlob: "",
              references: [taggedReference(41 + offset, 0)],
            })),
          ];
          return grant.claim(raced, admit);
        },
        settle: () => {
          settlements++;
          return Promise.resolve();
        },
      };

      const result = await processRefundBatchAt(source, [candidate(40, 1)], 7, {
        claim: raceClaim,
      });

      expectBudgetRefusal(result);
      expect(settlements).toBe(0);
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
    });

    test("executes every cheap returned payment in an admitted command", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const attendeeIds = Array.from({ length: 6 }, (_, offset) => 60 + offset);
      const candidates = attendeeIds.map((attendeeId) =>
        candidate(attendeeId, 1, "completed")
      );
      const claim = grantingRowClaim(
        new Map(
          attendeeIds.map((attendeeId) => [
            attendeeId,
            [`session_pi_budget_${attendeeId}_0`],
          ]),
        ),
      );
      const recordedAttendees: number[] = [];

      const result = await processRefundBatchAt(source, candidates, 7, {
        claim,
        record: (postings) => {
          recordedAttendees.push(
            ...postings.map(({ attendeeId }) => attendeeId),
          );
          return recordEveryRefund(postings);
        },
      });

      expect(result).toMatchObject({
        counts: { refundedCount: attendeeIds.length },
        kind: "finished",
      });
      expect(recordedAttendees.sort()).toEqual(attendeeIds);
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
    });

    test("rechecks the exact set immediately before provider preparation", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const granted = grantingRowClaim(
        new Map([[70, ["session_pi_budget_70_0"]]]),
      );
      const claim: RowClaim = {
        claim: async (attendees, admit) => {
          const result = await granted.claim(attendees, admit);
          if (result.kind === "claimed") {
            const remainingBeforeWork =
              REFUND_SETTLEMENT_SUBREQUEST_RESERVE.total + 5;
            while (getSubrequestRemaining().total > remainingBeforeWork) {
              countSubrequest("database", "concurrent command work");
            }
          }
          return result;
        },
        settle: granted.settle,
      };

      const result = await runWithSubrequestBudget(() =>
        processRefundBatchAt(source, [candidate(70, 1)], 7, {
          claim,
          record: recordEveryRefund,
        })
      );

      expectBudgetRefusal(result);
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
      expect(granted.released).toHaveLength(1);
    });

    test("keeps the send envelope protected inside the authority", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const granted = grantingRowClaim(
        new Map([[71, ["session_pi_budget_71_0"]]]),
      );
      let authorityCalls = 0;

      const result = await processRefundBatchAt(source, [candidate(71, 1)], 7, {
        request: async (...args) => {
          authorityCalls++;
          const sendEnvelope = 2 * (REFUND_NETWORK_RETRIES.stripe + 1);
          expect(getSubrequestRemaining().external).toBeGreaterThanOrEqual(
            sendEnvelope,
          );
          return await requestRecordedProviderRefund(...args);
        },
        claim: granted,
        record: recordEveryRefund,
      });

      expect(result).toMatchObject({
        counts: { failedCount: 1 },
        kind: "finished",
      });
      expect(source.reads).toEqual(["pi_budget_71_0"]);
      expect(authorityCalls).toBe(1);
      expect(source.refunds).toEqual(["pi_budget_71_0"]);
      expect(granted.released).toEqual([["session_pi_budget_71_0"]]);
    });

    test("refuses returned no-send work before its ledger when only four calls remain", async () => {
      const attendeeId = 73;
      const sessionId = "session_pi_budget_73_0";
      const source = provider({ paymentProvider: "square" });
      const granted = grantingRowClaim(new Map([[attendeeId, [sessionId]]]));
      let ledgerCalls = 0;
      const prepare = prepareAtProvider(source);

      const result = await processRefundBatch(
        [candidate(attendeeId, 1, "completed", "square")],
        7,
        {
          claim: granted,
          prepare: async (candidates, claim, returned) => {
            const prepared = await prepare(candidates, claim, returned);
            while (getSubrequestRemaining().database > 4) {
              countSubrequest(
                "database",
                "work racing returned-payment recording",
              );
            }
            return prepared;
          },
          record: (postings) => {
            ledgerCalls++;
            return recordEveryRefund(postings);
          },
        },
      );

      expectBudgetRefusal(result);
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
      expect(ledgerCalls).toBe(0);
      expect(granted.unrecorded).toEqual([[sessionId]]);
    });

    test("settlement reserve survives a work allowance failure", async () => {
      let settlementRemaining = -1;
      const granted = grantingRowClaim(
        new Map([[50, ["session_pi_budget_50_0"]]]),
      );
      const claim: RowClaim = {
        claim: granted.claim,
        settle: (change) => {
          settlementRemaining = getSubrequestRemaining().database;
          return granted.settle(change);
        },
      };

      await runWithSubrequestBudget(async () => {
        countSubrequest("database", "request work");
        const result = await processRefundBatchAt(
          provider({ paymentProvider: "square" }),
          [candidate(50, 1, "none", "square")],
          7,
          { claim, record: recordEveryRefund },
        );

        expect(result.kind).not.toBe("blocked");
        expect(settlementRemaining).toBe(49);
        expect(getSubrequestRemaining().database).toBe(49);
        countSubrequest("database", "caller activity write");
      });
    });

    test("refuses two independently retryable sends from the request boundary", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider({
        refunded: new Set(["pi_budget_80_0", "pi_budget_80_1"]),
      });
      const granted = grantingRowClaim(
        new Map([[80, ["session_pi_budget_80_0", "session_pi_budget_80_1"]]]),
      );

      await runWithSubrequestBudget(async () => {
        const result = await processRefundBatchAt(
          source,
          [candidate(80, 2)],
          7,
          { claim: granted, record: recordEveryRefund },
        );

        expectBudgetRefusal(result);
      });
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
    });
  },
);
