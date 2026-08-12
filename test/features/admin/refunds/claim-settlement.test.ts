import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { REFUND_SETTLEMENT_SUBREQUEST_RESERVE } from "#routes/admin/refunds/budget.ts";
import { underAttendeeClaim } from "#routes/admin/refunds/claim.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  countSubrequest,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { claimedRows, claimResult } from "./claim-helpers.ts";

describe("admin refunds > attendee claim settlement", () => {
  const errors = setupErrorSpy();

  for (const capability of ["keyed", "keyless"] as const) {
    test(`keeps an inherited ${capability} hold when cleanup reserve is unavailable`, async () => {
      const attendeeId = 5;
      const sessionId = `sess-${capability}`;
      const loadedClaim = claimedRows(
        new Map([[attendeeId, [sessionId]]]),
        new Map([[attendeeId, new Map([[`index-${capability}`, capability]])]]),
      );
      const claimed = {
        ...loadedClaim,
        phases: new Map([[sessionId, "send_armed"]]),
      } satisfies ReturnType<typeof claimedRows>;
      const claim = claimResult(claimed);
      let worked = false;

      await runWithSubrequestBudget(async () => {
        const callsBeforeReserveRefusal =
          BUNNY_SUBREQUEST_LIMIT -
          REFUND_SETTLEMENT_SUBREQUEST_RESERVE.total +
          1;
        for (let call = 0; call < callsBeforeReserveRefusal; call++) {
          countSubrequest("database", "earlier refund work");
        }
        await expect(
          underAttendeeClaim(claim, [], 10, {
            blocked: () => "blocked",
            work: () => {
              worked = true;
              return Promise.resolve("worked");
            },
          }),
        ).rejects.toThrow("Subrequest reserve unavailable");
      });

      expect(worked).toBe(false);
      expect(claim.settlements).toEqual([]);
    });
  }

  test("reports a settlement failure without replacing the work failure", async () => {
    const claim = claimResult(claimedRows(new Map([[1, ["sess-one"]]])), () =>
      Promise.reject(new Error("the row would not let go")),
    );

    await expect(
      underAttendeeClaim(claim, [], 11, {
        blocked: () => "blocked",
        work: () => Promise.reject(new Error("the provider fell over")),
      }),
    ).rejects.toThrow("the provider fell over");

    expect(claim.settlements).toHaveLength(1);
    expect(
      errors.contains(
        "Refund claim could not be settled: Error: the row would not let go",
      ),
    ).toBe(true);
  });

  test("settles discovered facts and keeps uncertain claims when work raises", async () => {
    const claim = claimResult(
      claimedRows(
        new Map([[1, ["sess-unrecorded", "sess-review", "sess-uncertain"]]]),
      ),
    );

    await expect(
      underAttendeeClaim(claim, [], 12, {
        blocked: () => "blocked",
        work: ({ findings }) => {
          findings.unrecorded.set(1, ["sess-unrecorded"]);
          findings.reviews.set("sess-review", {
            kind: "review",
            reason: { kind: "partially_returned_obligation" },
          });
          findings.doubts.set(1, "in_doubt");
          return Promise.reject(new Error("the ledger fell over"));
        },
      }),
    ).rejects.toThrow("the ledger fell over");

    expect(claim.settlements).toEqual([
      {
        commandId: "test-command",
        heldSince: "2026-08-11T12:00:00.000Z",
        rows: new Map([
          [
            "sess-unrecorded",
            {
              books: "unrecorded",
              claim: "keep",
              phase: "checking",
            },
          ],
          [
            "sess-review",
            {
              claim: "keep",
              phase: "checking",
              review: {
                kind: "review",
                reason: { kind: "partially_returned_obligation" },
              },
            },
          ],
        ]),
      },
    ]);
  });

  test("rejects a row reported as both recorded and unrecorded", async () => {
    const claim = claimResult(
      claimedRows(new Map([[1, ["sess-contradictory"]]])),
    );

    await expect(
      underAttendeeClaim(claim, [], 13, {
        blocked: () => "blocked",
        work: ({ findings }) => {
          findings.recorded.add("sess-contradictory");
          findings.unrecorded.set(1, ["sess-contradictory"]);
          return Promise.resolve("worked");
        },
      }),
    ).rejects.toThrow(
      "Refund row sess-contradictory was both recorded and unrecorded",
    );
    expect(claim.settlements).toEqual([]);
  });
});
