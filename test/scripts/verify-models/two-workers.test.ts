/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type ClaimRequest, decideClaim } from "#payment/claim.ts";
import {
  EMPTY_ROW_STATE,
  type RefundClaim,
  type RefundClaimPhase,
} from "#payment/row-state.ts";
import {
  checkingClaimFor,
  claimHeldBy,
  grantClaim,
  settledRowState,
} from "#payment/row-transitions.ts";
import { twoWorkersModelData } from "#scripts/verify-models/two-workers.ts";
import { members, records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const REQUEST: ClaimRequest = { attendeeIds: [7], scope: "attendee_set" };
const W1_WRITTEN = "2026-01-01T00:00:00.000Z";
const W2_WRITTEN = "2026-01-02T00:00:00.000Z";
const RETURNED_AT = "2026-01-03T00:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

const runClaim = (commandId: string, writtenAt: string): RefundClaim =>
  checkingClaimFor(REQUEST, commandId, writtenAt);
const w1Claim = runClaim("refund-run-a", W1_WRITTEN);
const w2Claim = runClaim("refund-run-b", W2_WRITTEN);

/** The claim one run writes, keyed by its worker id. */
const newClaimOf = (worker: "w1" | "w2") =>
  worker === "w1"
    ? { newCommandId: "refund-run-a", newWrittenAt: W1_WRITTEN }
    : { newCommandId: "refund-run-b", newWrittenAt: W2_WRITTEN };

const w1Fence = {
  commandId: "refund-run-a",
  heldSince: W1_WRITTEN,
  phase: "checking" as RefundClaimPhase,
};

describe("two-worker claim ownership data", () => {
  test("keeps command, time and phase as separate fence facts", async () => {
    const data = await twoWorkersModelData();

    expect(members(data, "Workers")).toEqual(
      expect.arrayContaining(["w1", "w2"]),
    );
    expect(records(data, "WorkerFenceFacts")).toEqual(
      expect.arrayContaining([
        {
          commandId: "refund-run-a",
          phase: "checking",
          worker: "w1",
          writtenAt: W1_WRITTEN,
        },
        {
          commandId: "refund-run-b",
          phase: "checking",
          worker: "w2",
          writtenAt: W2_WRITTEN,
        },
      ]),
    );
  });

  test("grants an absent row and resumes an expired claim", async () => {
    const data = await twoWorkersModelData();
    const takes = records(data, "TakeFacts");

    for (const worker of ["w1", "w2"] as const) {
      const claim = newClaimOf(worker);
      expect(takes).toContainEqual({
        ...claim,
        admitted: true,
        existingClaimStale: false,
        existingOwner: "none",
        newPhase: "checking",
        worker,
      });
      expect(takes).toContainEqual({
        ...claim,
        admitted: true,
        existingClaimStale: true,
        existingOwner: "w2",
        newPhase: "checking",
        worker,
      });
    }
  });

  test("refuses a live claim another run holds", async () => {
    const data = await twoWorkersModelData();
    const takes = records(data, "TakeFacts");

    for (const worker of ["w1", "w2"] as const) {
      const claim = newClaimOf(worker);
      for (const owner of ["w1", "w2"]) {
        expect(takes).toContainEqual({
          ...claim,
          admitted: false,
          existingClaimStale: false,
          existingOwner: owner,
          newPhase: "checking",
          worker,
        });
      }
    }
  });

  test("an exact fence releases the owner's claim", async () => {
    const data = await twoWorkersModelData();
    const settles = records(data, "SettleFacts");

    expect(settles).toContainEqual({
      accepted: true,
      fenceCommandId: "refund-run-a",
      fencePhase: "checking",
      fenceWorker: "w1",
      fenceWrittenAt: W1_WRITTEN,
      storedCommandId: "refund-run-a",
      storedOwner: "w1",
      storedPhase: "checking",
      storedWrittenAt: W1_WRITTEN,
    });
    expect(settles).toContainEqual({
      accepted: true,
      fenceCommandId: "refund-run-b",
      fencePhase: "checking",
      fenceWorker: "w2",
      fenceWrittenAt: W2_WRITTEN,
      storedCommandId: "refund-run-b",
      storedOwner: "w2",
      storedPhase: "checking",
      storedWrittenAt: W2_WRITTEN,
    });
  });

  test("a fence that omits any one comparison fact never settles", async () => {
    const data = await twoWorkersModelData();
    const settles = records(data, "SettleFacts");
    const ownStored = {
      storedCommandId: "refund-run-a",
      storedOwner: "w1",
      storedPhase: "checking",
      storedWrittenAt: W1_WRITTEN,
    };
    const exactFence = {
      fenceCommandId: "refund-run-a",
      fencePhase: "checking",
      fenceWorker: "w1",
      fenceWrittenAt: W1_WRITTEN,
    };
    for (const changed of [
      { fenceCommandId: "refund-run-b" },
      { fenceWrittenAt: W2_WRITTEN },
      { fencePhase: "other" },
    ]) {
      expect(settles).toContainEqual({
        ...ownStored,
        ...exactFence,
        ...changed,
        accepted: false,
      });
    }
  });

  test("a stale run cannot settle the replacement's claim", async () => {
    const data = await twoWorkersModelData();
    const settles = records(data, "SettleFacts");

    expect(settles).toContainEqual({
      accepted: false,
      fenceCommandId: "refund-run-a",
      fencePhase: "checking",
      fenceWorker: "w1",
      fenceWrittenAt: W1_WRITTEN,
      storedCommandId: "refund-run-b",
      storedOwner: "w2",
      storedPhase: "checking",
      storedWrittenAt: W2_WRITTEN,
    });
  });

  test("the claim comparison refuses each omitted component on the real claim", () => {
    expect(claimHeldBy(w2Claim, w1Fence)).toBe(false);
    expect(
      claimHeldBy(w1Claim, {
        commandId: "refund-run-b",
        heldSince: W1_WRITTEN,
        phase: "checking",
      }),
    ).toBe(false);
    expect(
      claimHeldBy(w1Claim, {
        commandId: "refund-run-a",
        heldSince: W2_WRITTEN,
        phase: "checking",
      }),
    ).toBe(false);
    expect(
      claimHeldBy(w1Claim, {
        commandId: "refund-run-a",
        heldSince: W1_WRITTEN,
        phase: "other" as RefundClaimPhase,
      }),
    ).toBe(false);
    expect(claimHeldBy(w1Claim, w1Fence)).toBe(true);
  });

  test("the row transition leaves the replacement claim untouched", () => {
    const underW2 = grantClaim(EMPTY_ROW_STATE, w2Claim);
    expect(
      settledRowState(
        underW2,
        { claim: "release", phase: "checking" },
        { commandId: w1Fence.commandId, heldSince: w1Fence.heldSince },
        RETURNED_AT,
      ),
    ).toBeNull();
    expect(
      settledRowState(
        grantClaim(EMPTY_ROW_STATE, w1Claim),
        { claim: "release", phase: "checking" },
        { commandId: w1Fence.commandId, heldSince: w1Fence.heldSince },
        RETURNED_AT,
      ),
    ).not.toBeNull();
  });

  test("a live replacement claim is not taken over until it expires", () => {
    expect(decideClaim(w2Claim, REQUEST, W2_WRITTEN)).toEqual({ kind: "held" });
    expect(decideClaim(w2Claim, REQUEST, FAR_FUTURE)).toEqual({
      kind: "resume",
      resuming: w2Claim,
    });
  });
});
