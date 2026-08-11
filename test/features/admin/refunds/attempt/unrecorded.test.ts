import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundCandidateAtProvider } from "#routes/admin/refunds/attempt.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import {
  candidate,
  candidateWithReferences,
  finishedCounts,
  provider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

describe("admin refund provider > an unrecorded refund", () => {
  const keyless = provider({
    refundCapability: "keyless",
    refunded: new Set(["pi_unrecorded", "pi_recorded"]),
  });

  test("a refund the provider rejected leaves no doubt", async () => {
    const result = await refundCandidateAtProvider(
      provider({ refundCapability: "keyless" }),
      candidateWithReferences(["pi_unanswered"]),
      7,
      () => Promise.resolve(),
    );

    expect(result.outcome).toBe("failed");
    expect(result.doubt).toBeUndefined();
  });

  test("a reading the provider could not give leaves the hold free", async () => {
    const unreadable = provider({
      read: () => {
        throw new Error("the provider could not be reached");
      },
      refundCapability: "keyless",
    });

    const result = await refundCandidateAtProvider(
      unreadable,
      candidateWithReferences(["pi_unreadable"]),
      7,
      () => Promise.resolve(),
    );

    // Nothing was sent, but the run did not learn what an inherited hold did.
    expect(result.outcome).toBe("withheld");
    expect(result.doubt).toBe("unread");
  });

  test("a refund never sent is settled — nothing was asked for", async () => {
    const alreadyBack = provider({
      alreadyRefunded: new Set(["pi_already"]),
      refundCapability: "keyless",
    });

    const result = await refundCandidateAtProvider(
      alreadyBack,
      candidateWithReferences(["pi_already"]),
      7,
      () => Promise.resolve(),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBeUndefined();
  });

  test("a refund whose returned-marker write fails leaves a lost answer", async () => {
    const result = await refundCandidateAtProvider(
      keyless,
      candidateWithReferences(["pi_unrecorded"]),
      7,
      () => Promise.reject(new Error("the marker could not be written")),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBe("in_doubt");
  });

  test("a marker write that fails beside a refused sibling keeps the doubt", async () => {
    const result = await refundCandidateAtProvider(
      keyless,
      candidateWithReferences(["pi_recorded", "pi_refused"]),
      7,
      () => Promise.reject(new Error("the marker could not be written")),
    );

    expect(result.outcome).toBe("errored");
    expect(result.returned.map(({ reference }) => reference)).toEqual([
      "pi_recorded",
    ]);
    expect(result.doubt).toBe("in_doubt");
  });

  test("a refund whose marker write succeeds is settled", async () => {
    const result = await refundCandidateAtProvider(
      keyless,
      candidateWithReferences(["pi_recorded"]),
      7,
      () => Promise.resolve(),
    );

    expect(result.outcome).toBe("refunded");
    expect(result.doubt).toBeUndefined();
  });

  test("a failed marker retains the claim after ledger repair also fails", async () => {
    const claim = grantingRowClaim(
      new Map([[11, ["sess_pi_returned", "sess_pi_refused"]]]),
    );
    const recordedSessions: string[] = [];
    const counts = finishedCounts(
      await processRefundBatch(
        provider({ refunded: new Set(["pi_returned"]) }),
        [
          candidate(
            [{ reference: "pi_returned" }, { reference: "pi_refused" }],
            11,
          ),
        ],
        7,
        {
          claim,
          markReturned: () =>
            Promise.reject(new Error("the marker could not be written")),
          record: (attendees) => {
            recordedSessions.push(
              ...attendees.flatMap(({ references }) =>
                references.flatMap(({ sessionIds }) => sessionIds),
              ),
            );
            return Promise.resolve(
              new Map(attendees.map(({ attendeeId }) => [attendeeId, false])),
            );
          },
        },
      ),
    );

    expect(recordedSessions).toEqual(["sess_pi_returned"]);
    expect(counts.notRecordedCount).toBe(1);
    expect(claim.released).toEqual([]);
    expect(claim.unrecorded).toEqual([]);
  });

  /** Run one keyless attendee with the requested ledger and provider answer. */
  const keylessRun = async (
    posted: boolean,
    refunds = ["pi_held"],
    uncertain = false,
  ) => {
    const claim = grantingRowClaim(new Map([[11, ["sess_pi_held"]]]));
    await processRefundBatch(
      provider({
        refundCapability: "keyless",
        refunded: new Set(refunds),
        throws: uncertain ? new Set(["pi_held"]) : new Set(),
      }),
      [candidate([{ reference: "pi_held" }], 11)],
      7,
      {
        claim,
        markReturned: () => Promise.resolve(),
        record: (attendees) =>
          Promise.resolve(
            new Map(attendees.map(({ attendeeId }) => [attendeeId, posted])),
          ),
      },
    );
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
