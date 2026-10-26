import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  heldSessionIds,
  makeClaimsStale,
  protectedStateOf,
  putRowState,
  releaseClaimRows,
  staleClaimSlot,
} from "#test-utils/payment-claim.ts";
import { checkPaymentSeam } from "#test-utils/payment-seam.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";

describeWithEnv(
  "db > taking a payment claim > resuming a stalled run",
  { db: true, encryptionKey: true },
  () => {
    checkPaymentSeam();

    test("a stalled checking fence can be resumed", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-inherit-unresolved",
        "pi_inherit_unresolved",
      );
      await putRowState(
        "sess-inherit-unresolved",
        await staleClaimSlot(attendeeId),
        CLAIM_MIRROR,
      );

      const resumed = await claimCurrentAttendeeRows([attendeeId]);

      expect(resumed).toMatchObject({ kind: "claimed" });
      expect(await claimCurrentAttendeeRows([attendeeId])).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("a fresh row receives a checking fence", async () => {
      const attendeeId = await bookedWithPayment("sess-grant", "pi_grant");
      const result = await claimCurrentAttendeeRows([attendeeId]);
      expect(result).toMatchObject({ kind: "claimed" });
      if (result.kind !== "claimed") throw new Error("claim was refused");
      expect([...result.phases.values()]).toEqual(["checking"]);
    });

    test("a stalled release does not strip its successor", async () => {
      const attendeeId = await bookedWithPayment("sess-stall", "pi_stall");
      const stalled = await claimCurrentAttendeeRows([attendeeId]);
      if (stalled.kind !== "claimed") {
        throw new Error("the claim was refused");
      }
      await releaseClaimRows(stalled, heldSessionIds(stalled));
      const resumed = await claimCurrentAttendeeRows([attendeeId]);
      if (resumed.kind !== "claimed") {
        throw new Error("the resume was refused");
      }

      await releaseClaimRows(stalled, heldSessionIds(stalled));

      expect(resumed.heldSince).not.toBe(stalled.heldSince);
      expect(await protectedStateOf("sess-stall")).toBe(CLAIM_MIRROR);
      expect(await claimCurrentAttendeeRows([attendeeId])).toEqual({
        blockedBy: { kind: "held" },
        kind: "blocked",
      });
    });

    test("a stale hold on somebody else's row still blocks", async () => {
      const other = await bookedWithPayment("sess-p1", "pi_shared_stale");
      const ours = await bookedWithPayment("sess-p2", "pi_shared_stale");
      await putRowState("sess-p1", await staleClaimSlot(other), CLAIM_MIRROR);

      expect(await claimCurrentAttendeeRows([ours])).toEqual({
        blockedBy: { kind: "foreign" },
        kind: "blocked",
      });
    });

    test("a crashed shared claim resumes from the attendee who started it", async () => {
      const first = await bookedWithPayment(
        "sess-shared-owner-a",
        "pi_shared_owner",
      );
      await bookedWithPayment("sess-shared-owner-b", "pi_shared_owner");
      const started = await claimCurrentAttendeeRows([first]);
      if (started.kind !== "claimed") {
        throw new Error("the claim was refused");
      }
      await makeClaimsStale(heldSessionIds(started));

      const resumed = await claimCurrentAttendeeRows([first]);

      expect(resumed).toMatchObject({ kind: "claimed" });
      if (resumed.kind !== "claimed") {
        throw new Error("the resume was refused");
      }
      expect(heldSessionIds(resumed).sort()).toEqual([
        "sess-shared-owner-a",
        "sess-shared-owner-b",
      ]);
    });
  },
);
