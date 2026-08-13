import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { refundReadinessSubrequestCost } from "#routes/admin/refunds/budget.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { refreshClaimedPayment } from "#routes/admin/refunds/refresh.ts";
import { settings } from "#shared/db/settings.ts";
import {
  countSubrequest,
  getSubrequestRemaining,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import {
  candidate,
  tagged,
} from "#test/features/admin/refunds/readiness/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const REFUSED = {
  kind: "not_ready",
  message:
    "This attendee has too many payments to refresh safely in one request. No provider was contacted, and automatic refresh is unavailable for this payment set.",
} as const;

const references = (count: number, label: string) =>
  Array.from(
    { length: count },
    (_, offset) =>
      tagged(`pi_${label}_${offset}`, "stripe", `${label}_${offset}`),
  );

const runRefusedRefresh = async (
  attendeeId: number,
  attendeeReferences: ReturnType<typeof references>,
  claim: RowClaim,
): Promise<{
  providerReads: number;
  result: Awaited<ReturnType<typeof refreshClaimedPayment>>;
}> => {
  await settings.update.stripe.secretKey("sk_test_refresh_budget");
  let providerReads = 0;
  const result = await runWithSubrequestBudget(() =>
    refreshClaimedPayment(candidate(attendeeId, attendeeReferences), 17, {
      claim,
      prepare: () => {
        providerReads++;
        throw new Error("Provider preparation exceeded its budget");
      },
    })
  );
  return { providerReads, result };
};

const runCountedRefresh = async (
  attendeeId: number,
  referenceCount: number,
): Promise<{
  claims: number;
  providerReads: number;
  result: Awaited<ReturnType<typeof refreshClaimedPayment>>;
}> => {
  await settings.update.stripe.secretKey("sk_test_refresh_budget");
  const claimed = countedClaim();
  let providerReads = 0;
  const result = await runWithSubrequestBudget(() =>
    refreshClaimedPayment(
      candidate(attendeeId, references(referenceCount, "full")),
      17,
      {
        claim: claimed.claim,
        prepare: () => {
          providerReads++;
          return Promise.resolve({
            kind: "not_ready",
            observations: [],
            reason: "claim_changed",
          });
        },
      },
    )
  );
  return { claims: claimed.count(), providerReads, result };
};

const countedClaim = (databaseCalls = 0) => {
  const rows = grantingRowClaim();
  let count = 0;
  const claim: RowClaim = {
    claim: (attendees, admit) => {
      count++;
      for (let call = 0; call < databaseCalls; call++) {
        countSubrequest("database", "claiming refresh rows");
      }
      return rows.claim(attendees, admit);
    },
    settle: rows.settle,
  };
  return { claim, count: () => count };
};

describeWithEnv(
  "admin refund refresh > whole-command budget",
  { db: true },
  () => {
    test("refuses a merged payment set before claiming rows or reading providers", async () => {
      const claimed = countedClaim();

      const run = await runRefusedRefresh(
        23,
        references(30, "merged"),
        claimed.claim,
      );

      expect(run.result).toEqual(REFUSED);
      expect(claimed.count()).toBe(0);
      expect(run.providerReads).toBe(0);
    });

    test("refuses an exact row set that grows beyond the limit inside the claim", async () => {
      const granted = grantingRowClaim();
      const claim: RowClaim = {
        claim: ([attendee], admit) => {
          if (attendee === undefined || admit === undefined) {
            throw new Error("Refresh claim omitted its exact admission gate");
          }
          for (let call = 0; call < 4; call++) {
            countSubrequest("database", "claiming raced refresh rows");
          }
          return granted.claim(
            [{ ...attendee, references: references(18, "raced") }],
            admit,
          );
        },
        settle: granted.settle,
      };

      const run = await runRefusedRefresh(24, references(1, "loaded"), claim);

      expect(run.result).toEqual(REFUSED);
      expect(run.providerReads).toBe(0);
      expect(granted.released).toEqual([]);
    });

    test("rechecks remaining room immediately before its provider reads", async () => {
      const granted = grantingRowClaim(new Map([[25, ["session_recheck_0"]]]));
      const claim: RowClaim = {
        claim: async (attendees, admit) => {
          const claimed = await granted.claim(attendees, admit);
          if (claimed.kind === "claimed") {
            const providerReadCost = refundReadinessSubrequestCost(
              "refresh",
              attendees,
              claimed.returned,
              "before_provider_read",
            );
            // The claim wrapper already withholds settlement while this hook
            // runs, so leave the provider-read plan one call short directly.
            const remainingBeforeWork = providerReadCost.total - 1;
            while (getSubrequestRemaining().total > remainingBeforeWork) {
              countSubrequest("database", "work racing payment refresh");
            }
          }
          return claimed;
        },
        settle: granted.settle,
      };

      const run = await runRefusedRefresh(25, references(1, "recheck"), claim);

      expect(run.result).toEqual(REFUSED);
      expect(run.providerReads).toBe(0);
      expect(granted.released).toEqual([["session_recheck_0"]]);
    });

    test("reserves settlement before a route-sized refresh can claim rows", async () => {
      await settings.update.stripe.secretKey("sk_test_refresh_budget");
      const claimed = countedClaim(6);
      let providerReads = 0;

      const result = await runWithSubrequestBudget(async () => {
        countSubrequest("database", "attendee refresh route load");
        countSubrequest("database", "attendee booking route load");
        return await refreshClaimedPayment(
          candidate(26, references(16, "route")),
          17,
          {
            claim: claimed.claim,
            prepare: () => {
              providerReads++;
              throw new Error("Provider preparation exceeded its budget");
            },
          },
        );
      });

      expect(result).toEqual(REFUSED);
      expect(claimed.count()).toBe(0);
      expect(providerReads).toBe(0);
    });

    test("refuses two independently retryable observations before provider reads", async () => {
      const run = await runCountedRefresh(27, 2);

      expect(run.result).toEqual(REFUSED);
      expect(run.claims).toBe(1);
      expect(run.providerReads).toBe(0);
    });

    test("admits one observation with its full physical retry envelope", async () => {
      const run = await runCountedRefresh(28, 1);

      expect(run.result).toMatchObject({ kind: "not_ready" });
      expect(run.claims).toBe(1);
      expect(run.providerReads).toBe(1);
    });
  },
);
