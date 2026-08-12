import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  REFUND_BUDGET_MESSAGES,
  REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
} from "#routes/admin/refunds/budget.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { settings } from "#shared/db/settings.ts";
import { STRIPE_MAX_NETWORK_RETRIES } from "#shared/stripe/request.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { armEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  processRefundBatchAt,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { recordEveryRefund } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;

const stripeReference = (
  attendeeId: number,
  offset: number,
  refundState: RefundPaymentReference["refundState"] = "none",
): TaggedReference => {
  const reference = `pi_budget_${attendeeId}_${offset}`;
  const index = `index_of_stripe_${reference}`;
  const sessionId = `session_${reference}`;
  return {
    heldRowSessionIds: [],
    index,
    kind: "tagged",
    matchingIndexes: [index],
    provider: "stripe",
    reference,
    refundState,
    rowSessionIds: [sessionId],
    sessionIds: [sessionId],
  };
};

const candidate = (attendeeId: number, referenceCount: number) => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: Array.from({ length: referenceCount }, (_, offset) =>
    stripeReference(attendeeId, offset),
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

describeWithEnv(
  "admin refund provider > whole-command budget",
  { db: true },
  () => {
    test("six Stripe payments on one attendee make zero provider calls", async () => {
      await expectRefusedBeforeClaim([candidate(11, 6)]);
    });

    test("an oversized bulk command refuses every attendee before provider work", async () => {
      const candidates = Array.from({ length: 6 }, (_, offset) =>
        candidate(20 + offset, 1),
      );
      await expectRefusedBeforeClaim(candidates);
    });

    test("the single-attendee surface gives its own dashboard guidance", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const result = await processRefundBatchAt(source, [candidate(30, 6)], 7, {
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
      let settlements = 0;
      const raceClaim: RowClaim = {
        claim: (attendees, admit) => {
          if (admit === undefined) throw new Error("No exact budget admission");
          const raced = [
            ...attendees,
            ...Array.from({ length: 5 }, (_, offset) => ({
              attendeeId: 41 + offset,
              loadedPiiBlob: "",
              references: [stripeReference(41 + offset, 0)],
            })),
          ];
          return Promise.resolve(
            admit({
              attendees: raced,
              inherited: new Map(),
              returned: new Set(),
            })
              ? { kind: "changed" as const }
              : { kind: "not_admitted" as const },
          );
        },
        settle: () => {
          settlements++;
          return Promise.resolve();
        },
      };

      const result = await processRefundBatchAt(source, [candidate(40, 1)], 7, {
        claim: raceClaim,
      });

      expect(result).toMatchObject({
        kind: "not_ready",
        reason: "subrequest_budget",
      });
      expect(settlements).toBe(0);
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
    });

    test("the claim chooses resumed work from authoritative rows", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const candidates = Array.from({ length: 6 }, (_, offset) => ({
        attendee: { id: 60 + offset } as RefundCandidate["attendee"],
        references:
          offset === 5
            ? Array.from({ length: 6 }, (_, referenceOffset) =>
                stripeReference(65, referenceOffset),
              )
            : [stripeReference(60 + offset, 0, "completed")],
      }));
      let claims = 0;
      const claim: RowClaim = {
        claim: (attendees, admit) => {
          claims++;
          if (admit === undefined) throw new Error("No exact budget admission");
          const inherited = new Map([
            [
              65,
              new Map([[attendees[5]!.references[0]!.index, "keyed" as const]]),
            ],
          ]);
          return Promise.resolve(
            admit({ attendees, inherited, returned: new Set() })
              ? { kind: "changed" as const }
              : { kind: "not_admitted" as const },
          );
        },
        settle: () => Promise.resolve(),
      };

      const result = await processRefundBatchAt(source, candidates, 7, {
        claim,
      });

      expect(result).toMatchObject({
        kind: "not_ready",
        reason: "subrequest_budget",
      });
      expect(claims).toBe(1);
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
              REFUND_SETTLEMENT_SUBREQUEST_RESERVE.total + 6;
            while (getSubrequestRemaining().total > remainingBeforeWork) {
              countSubrequest("database", "concurrent command work");
            }
          }
          return result;
        },
        settle: granted.settle,
      };

      const result = await processRefundBatchAt(source, [candidate(70, 1)], 7, {
        claim,
        record: recordEveryRefund,
      });

      expect(result).toMatchObject({
        kind: "not_ready",
        reason: "subrequest_budget",
      });
      expect(source.reads).toEqual([]);
      expect(source.refunds).toEqual([]);
      expect(granted.released).toHaveLength(1);
    });

    test("rechecks the send envelope after arming before any refund call", async () => {
      await settings.update.stripe.secretKey("sk_test_budget");
      const source = provider();
      const granted = grantingRowClaim(
        new Map([[71, ["session_pi_budget_71_0"]]]),
      );
      const armRefunds = armEveryRefund();
      let armCalls = 0;

      const result = await processRefundBatchAt(source, [candidate(71, 1)], 7, {
        arm: async (request) => {
          armCalls++;
          const armed = await armRefunds(request);
          const sendEnvelope = 2 * (STRIPE_MAX_NETWORK_RETRIES + 1);
          while (getSubrequestRemaining().total >= sendEnvelope) {
            countSubrequest("database", "work racing the dispatch arm");
          }
          return armed;
        },
        claim: granted,
        record: recordEveryRefund,
      });

      expect(result).toMatchObject({
        kind: "not_ready",
        reason: "subrequest_budget",
      });
      expect(source.reads).toEqual(["pi_budget_71_0"]);
      expect(armCalls).toBe(1);
      expect(source.refunds).toEqual([]);
      expect(granted.released).toEqual([["session_pi_budget_71_0"]]);
    });

    test("settlement and caller reserves survive a work allowance failure", async () => {
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
          [candidate(50, 1)],
          7,
          { claim, record: recordEveryRefund },
        );

        expect(result.kind).not.toBe("blocked");
        expect(settlementRemaining).toBe(45);
        expect(getSubrequestRemaining().database).toBe(49);
        countSubrequest("database", "caller activity write");
      });
    });

    test("admits the normal two-Stripe-payment command from the request boundary", async () => {
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

        expect(result).toMatchObject({
          counts: { refundedCount: 1 },
          kind: "finished",
        });
      });
      expect(source.refunds.sort()).toEqual([
        "pi_budget_80_0",
        "pi_budget_80_1",
      ]);
    });
  },
);
