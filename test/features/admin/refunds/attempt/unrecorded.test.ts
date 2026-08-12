import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundReadyCandidate } from "#routes/admin/refunds/attempt.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  armEveryRefund,
  authorizeEveryRefund,
} from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidate,
  finishedCounts,
  provider,
  readyCandidate,
  readyCandidateWithReferences,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  recordEveryRefund,
  recordNoRefunds,
} from "#test/features/admin/refunds/provider/ledger-results.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

describe("admin refund provider > an unrecorded refund", () => {
  const keyless = provider({
    refundCapability: "keyless",
    refunded: new Set(["pi_unrecorded", "pi_recorded"]),
  });

  test("a refund the provider rejected leaves no doubt", async () => {
    const source = provider({ refundCapability: "keyless" });
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_unanswered"], source),
      7,
      () => Promise.resolve(),
      authorizeEveryRefund("keyless"),
    );

    expect(result.outcome).toBe("failed");
    expect(result.doubt).toBeUndefined();
  });

  test("a refund never sent is settled — nothing was asked for", async () => {
    const source = provider({ refundCapability: "keyless" });
    const result = await refundReadyCandidate(
      readyCandidate(
        [{ kind: "already_returned", reference: "pi_already" }],
        source,
      ),
      7,
      () => Promise.resolve(),
      authorizeEveryRefund("keyless"),
    );

    expect(source.refunds).toEqual([]);
    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBeUndefined();
  });

  test("a refund whose returned-marker write fails leaves a lost answer", async () => {
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_unrecorded"], keyless),
      7,
      () => Promise.reject(new Error("the marker could not be written")),
      authorizeEveryRefund("keyless"),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBe("in_doubt");
  });

  test("a marker write that fails beside a refused sibling keeps the doubt", async () => {
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_recorded", "pi_refused"], keyless),
      7,
      () => Promise.reject(new Error("the marker could not be written")),
      authorizeEveryRefund("keyless"),
    );

    expect(result.outcome).toBe("errored");
    expect(result.returned.map(({ reference }) => reference)).toEqual([
      "pi_recorded",
    ]);
    expect(result.doubt).toBe("in_doubt");
  });

  test("a refund whose marker write succeeds is settled", async () => {
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(["pi_recorded"], keyless),
      7,
      () => Promise.resolve(),
      authorizeEveryRefund("keyless"),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBeUndefined();
  });

  test("a failed marker retains the claim after ledger repair also fails", async () => {
    const claim = grantingRowClaim(
      new Map([[11, ["sess_pi_returned", "sess_pi_refused"]]]),
    );
    const recordedSessions: string[] = [];
    const source = provider({ refunded: new Set(["pi_returned"]) });
    const counts = finishedCounts(
      await processRefundBatch(
        [
          candidate(
            [{ reference: "pi_returned" }, { reference: "pi_refused" }],
            11,
          ),
        ],
        7,
        {
          arm: armEveryRefund(),
          claim,
          markReturned: () =>
            Promise.reject(new Error("the marker could not be written")),
          prepare: () =>
            Promise.resolve({
              candidates: [
                readyCandidateWithReferences(
                  ["pi_returned", "pi_refused"],
                  source,
                  11,
                ),
              ],
              kind: "ready",
            }),
          record: (attendees) => {
            recordedSessions.push(
              ...attendees.flatMap(({ references }) =>
                references.flatMap(({ sessionIds }) => sessionIds),
              ),
            );
            return recordNoRefunds(attendees);
          },
        },
      ),
    );

    expect(recordedSessions).toEqual(["sess_pi_returned"]);
    expect(counts.notRecordedCount).toBe(1);
    expect(claim.released).toEqual([[]]);
    expect(claim.unrecorded).toEqual([["sess_pi_returned"]]);
  });

  /** Run one keyless attendee with the requested ledger and provider answer. */
  const keylessRun = async (
    posted: boolean,
    refunds = ["pi_held"],
    uncertain = false,
  ) => {
    const claim = grantingRowClaim(new Map([[11, ["sess_pi_held"]]]));
    const source = provider({
      refundCapability: "keyless",
      refunded: new Set(refunds),
      throws: uncertain ? new Set(["pi_held"]) : new Set(),
    });
    await processRefundBatch([candidate([{ reference: "pi_held" }], 11)], 7, {
      arm: armEveryRefund("keyless"),
      claim,
      markReturned: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          candidates: [readyCandidateWithReferences(["pi_held"], source, 11)],
          kind: "ready",
        }),
      record: posted ? recordEveryRefund : recordNoRefunds,
    });
    return claim;
  };

  test("a keyless run keeps its hold while the answer is in doubt", async () => {
    expect((await keylessRun(true, [], true)).released).toEqual([]);
  });

  test("a keyless run lets go when the answer is settled", async () => {
    expect((await keylessRun(true)).released).toEqual([["sess_pi_held"]]);
  });

  test("a keyless run whose money the ledger missed lets go, marked", async () => {
    const claim = await keylessRun(false);

    expect(claim.released).toEqual([["sess_pi_held"]]);
    expect(claim.unrecorded).toEqual([["sess_pi_held"]]);
  });
});
