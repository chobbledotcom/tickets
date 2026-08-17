import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import { holdingClaim, refundReadyCandidate } from "./dispatch-helpers.ts";
import {
  candidate,
  finishedCounts,
  processRefundBatchAt,
  provider,
  readyCandidate,
} from "./helpers.ts";
import { recordEveryRefund } from "./ledger-results.ts";

describeWithEnv(
  "admin refund provider > the attendee fence",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    const blockedRowClaim = (): RowClaim => ({
      claim: () =>
        Promise.resolve({ blockedBy: { kind: "held" }, kind: "blocked" }),
      settle: () => Promise.resolve(),
    });

    test("a blocked run does not ask the provider", async () => {
      const untouched = provider({ refundCapability: "keyless" });
      const result = await processRefundBatchAt(
        untouched,
        [candidate([{ reference: "pi_held" }])],
        7,
        { claim: blockedRowClaim() },
      );

      expect(result).toEqual({ kind: "blocked", reason: "refund_in_progress" });
      expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
    });

    test("holds the whole batch once", async () => {
      const rowClaim = grantingRowClaim(
        new Map([
          [11, ["sess_pi_1"]],
          [12, ["sess_pi_2"]],
          [13, ["sess_pi_3"]],
        ]),
      );
      const claimed: number[][] = [];
      const counting: RowClaim = {
        claim: (attendees) => {
          claimed.push(attendees.map(({ attendeeId }) => attendeeId));
          return rowClaim.claim(attendees);
        },
        settle: rowClaim.settle,
      };

      const candidates = [
        candidate([{ reference: "pi_1", refundState: "completed" }], 11),
        candidate([{ reference: "pi_2", refundState: "completed" }], 12),
        candidate([{ reference: "pi_3", refundState: "completed" }], 13),
      ];
      await markProviderRefundsReturned(
        candidates.flatMap(({ references }) => references),
        "due",
      );
      await processRefundBatchAt(provider(), candidates, 7, {
        claim: counting,
        record: recordEveryRefund,
      });

      expect(claimed).toEqual([[11, 12, 13]]);
      expect(rowClaim.released).toHaveLength(1);
    });

    for (const capability of ["keyed", "keyless"] as const) {
      test(`releases the attendee fence after uncertain ${capability} work`, async () => {
        const rowClaim = grantingRowClaim(new Map([[42, ["sess_uncertain"]]]));

        await processRefundBatchAt(
          provider({
            refundCapability: capability,
            throws: new Set(["pi_uncertain"]),
          }),
          [
            candidate([
              {
                provider: capability === "keyless" ? "sumup" : "stripe",
                reference: "pi_uncertain",
              },
            ]),
          ],
          7,
          { claim: rowClaim },
        );

        expect(rowClaim.released).toEqual([["sess_uncertain"]]);
      });
    }

    test("uses a stored returned marker without provider IO", async () => {
      const untouched = provider({ refundCapability: "keyless" });
      const candidate = readyCandidate(
        [{ kind: "already_returned", reference: "pi_raced" }],
        untouched,
      );
      await markProviderRefundsReturned(
        candidate.references.map(({ reference }) => reference),
        "due",
      );
      const result = await refundReadyCandidate(candidate, 7);

      expect(result.outcome).toBe("refunded");
      expect([...untouched.reads, ...untouched.refunds]).toEqual([]);
    });

    test("reports and propagates a failed release after returned money", async () => {
      const refusingRelease = holdingClaim(
        () => Promise.reject(new Error("the row would not let go")),
        ["sess_pi_held"],
      );

      await expect(
        processRefundBatchAt(
          provider({ refunded: new Set(["pi_held"]) }),
          [candidate([{ reference: "pi_held" }], 11)],
          7,
          { claim: refusingRelease, record: recordEveryRefund },
        ),
      ).rejects.toThrow("the row would not let go");

      expect(errors.contains("Refund claim could not be settled")).toBe(true);
    });

    test("a changed payment set stands the whole run down", async () => {
      const changed: RowClaim = {
        claim: () => Promise.resolve({ kind: "changed" }),
        settle: () => Promise.resolve(),
      };
      const asked = provider({ refundCapability: "keyless" });

      const counts = finishedCounts(
        await processRefundBatchAt(
          asked,
          [candidate([{ reference: "pi_known" }], 11)],
          7,
          { claim: changed },
        ),
      );

      expect([...asked.reads, ...asked.refunds]).toEqual([]);
      expect(counts.failedCount).toBe(1);
    });
  },
);
