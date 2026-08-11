import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  heldSessionIds,
  protectedStateOf,
  putRowState,
  referenceIndexOf,
  releaseClaimRows,
  rowStateSlot,
  staleClaimSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv(
  "db > taking a payment claim",
  { db: true, encryptionKey: true },
  () => {
    describe("claiming", () => {
      test("an unclaimed attendee's rows are claimed", async () => {
        const attendeeId = await bookedWithPayment("sess-a", "pi_a");
        const result = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (result.kind !== "claimed") throw new Error("the claim was refused");
        expect(heldSessionIds(result)).toEqual(["sess-a"]);
        expect([...result.held.keys()]).toEqual([attendeeId]);
      });

      test("the claim shows in the plaintext mirror", async () => {
        const attendeeId = await bookedWithPayment("sess-b", "pi_b");
        const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(held.heldSince).not.toBe("");
        expect(await protectedStateOf("sess-b")).toBe(CLAIM_MIRROR);
      });

      test("a second run is told the work is in progress", async () => {
        const attendeeId = await bookedWithPayment("sess-c", "pi_c");
        await claimCurrentAttendeeRows([attendeeId], "keyless");
        expect(await claimCurrentAttendeeRows([attendeeId], "keyless")).toEqual(
          {
            blockedBy: { kind: "held" },
            kind: "blocked",
          },
        );
      });

      test("two concurrent runs on one attendee have one winner", async () => {
        const attendeeId = await bookedWithPayment("sess-d", "pi_d");
        const results = await Promise.all([
          claimCurrentAttendeeRows([attendeeId], "keyless"),
          claimCurrentAttendeeRows([attendeeId], "keyless"),
        ]);
        expect(
          results.filter((result) => result.kind === "claimed"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.kind === "blocked"),
        ).toHaveLength(1);
      });

      test("two attendees sharing one reference have one holder", async () => {
        const first = await bookedWithPayment("sess-e1", "pi_shared");
        const second = await bookedWithPayment("sess-e2", "pi_shared");

        const held = await claimCurrentAttendeeRows([first], "keyless");
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(heldSessionIds(held)).toEqual(["sess-e1"]);
        expect(await claimCurrentAttendeeRows([second], "keyless")).toEqual({
          blockedBy: { kind: "foreign" },
          kind: "blocked",
        });
      });

      test("concurrent shared-reference claims have one winner", async () => {
        const first = await bookedWithPayment("sess-f1", "pi_race");
        const second = await bookedWithPayment("sess-f2", "pi_race");
        const results = await Promise.all([
          claimCurrentAttendeeRows([first], "keyless"),
          claimCurrentAttendeeRows([second], "keyless"),
        ]);
        expect(
          results.filter((result) => result.kind === "claimed"),
        ).toHaveLength(1);
      });

      test("an unrelated attendee remains free", async () => {
        const first = await bookedWithPayment("sess-g1", "pi_g1");
        const second = await bookedWithPayment("sess-g2", "pi_g2");
        await claimCurrentAttendeeRows([first], "keyless");
        const secondClaim = await claimCurrentAttendeeRows([second], "keyless");
        if (secondClaim.kind !== "claimed") {
          throw new Error("the claim was refused");
        }
        expect(heldSessionIds(secondClaim)).toEqual(["sess-g2"]);
      });

      test("claiming nobody reaches no database", async () => {
        const calls = await countDatabaseCalls(0, async () => {
          const nobody = await claimCurrentAttendeeRows([], "keyless");
          if (nobody.kind !== "claimed") {
            throw new Error("the claim was refused");
          }
          expect(heldSessionIds(nobody)).toEqual([]);
        });
        expect(calls).toBe(0);
      });

      test("a missing attendee fails at the snapshot boundary", async () => {
        await expect(claimCurrentAttendeeRows([-1], "keyless")).rejects.toThrow(
          "Attendee -1 was not found before the claim",
        );
      });
    });

    describe("the reference index", () => {
      test("is written beside the reference", async () => {
        await bookedWithPayment("sess-h", "pi_h");
        expect(await referenceIndexOf("sess-h")).toBe(
          await paymentReferenceIndex(taggedPaymentReference("pi_h")),
        );
      });

      test("is stable for one reference and different between references", async () => {
        await bookedWithPayment("sess-i1", "pi_same");
        await bookedWithPayment("sess-i2", "pi_same");
        await bookedWithPayment("sess-j", "pi_other");
        expect(await referenceIndexOf("sess-i1")).toEqual(
          await referenceIndexOf("sess-i2"),
        );
        expect(await referenceIndexOf("sess-i1")).not.toEqual(
          await referenceIndexOf("sess-j"),
        );
      });

      test("does not expose the reference", async () => {
        await bookedWithPayment("sess-k", "pi_secret");
        const stored = await referenceIndexOf("sess-k");
        expect(stored).toBe(
          await paymentReferenceIndex(taggedPaymentReference("pi_secret")),
        );
        expect(stored).not.toContain("pi_secret");
      });
    });

    describe("resuming a stalled run", () => {
      test("names inherited doubt and keeps its capability", async () => {
        const attendeeId = await bookedWithPayment(
          "sess-inherit",
          "pi_inherit",
        );
        await putRowState(
          "sess-inherit",
          await staleClaimSlot(attendeeId, "keyless"),
          CLAIM_MIRROR,
        );

        const resumed = await claimCurrentAttendeeRows([attendeeId], "keyed");

        expect(resumed).toMatchObject({
          inherited: new Map([[attendeeId, "keyless"]]),
          kind: "claimed",
        });
      });

      test("a stalled unresolved claim predates any provider send", async () => {
        const attendeeId = await bookedWithPayment(
          "sess-inherit-unresolved",
          "pi_inherit_unresolved",
        );
        await putRowState(
          "sess-inherit-unresolved",
          await staleClaimSlot(attendeeId, "unresolved"),
          CLAIM_MIRROR,
        );

        const resumed = await claimCurrentAttendeeRows(
          [attendeeId],
          "unresolved",
        );

        expect(resumed).toMatchObject({
          inherited: new Map(),
          kind: "claimed",
        });
        expect(
          await claimCurrentAttendeeRows([attendeeId], "unresolved"),
        ).toEqual({ blockedBy: { kind: "held" }, kind: "blocked" });
      });

      test("a fresh grant has no inherited doubt", async () => {
        const attendeeId = await bookedWithPayment("sess-grant", "pi_grant");
        expect(
          await claimCurrentAttendeeRows([attendeeId], "keyless"),
        ).toMatchObject({ inherited: new Map() });
      });

      test("a stalled release does not strip its successor", async () => {
        const attendeeId = await bookedWithPayment("sess-stall", "pi_stall");
        const stalled = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (stalled.kind !== "claimed") {
          throw new Error("the claim was refused");
        }
        await releaseClaimRows(stalled, heldSessionIds(stalled));
        const resumed = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (resumed.kind !== "claimed") {
          throw new Error("the resume was refused");
        }

        await releaseClaimRows(stalled, heldSessionIds(stalled));

        expect(resumed.heldSince).not.toBe(stalled.heldSince);
        expect(await protectedStateOf("sess-stall")).toBe(CLAIM_MIRROR);
        expect(await claimCurrentAttendeeRows([attendeeId], "keyless")).toEqual(
          {
            blockedBy: { kind: "held" },
            kind: "blocked",
          },
        );
      });

      test("a stale hold on somebody else's row still blocks", async () => {
        const other = await bookedWithPayment("sess-p1", "pi_shared_stale");
        const ours = await bookedWithPayment("sess-p2", "pi_shared_stale");
        await putRowState("sess-p1", await staleClaimSlot(other), CLAIM_MIRROR);

        expect(await claimCurrentAttendeeRows([ours], "keyless")).toEqual({
          blockedBy: { kind: "foreign" },
          kind: "blocked",
        });
      });
    });

    describe("returned money", () => {
      test("names rows whose returned money is not in the books", async () => {
        const attendeeId = await bookedWithPayment(
          "sess-unrecorded",
          "pi_unrecorded",
        );
        await putRowState(
          "sess-unrecorded",
          await rowStateSlot({
            unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
          }),
          UNRECORDED_MIRROR,
        );

        const held = await claimCurrentAttendeeRows([attendeeId], "keyless");

        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(held.unrecorded).toEqual(
          new Map([[attendeeId, ["sess-unrecorded"]]]),
        );
      });

      test("names a reference this run's row says came back", async () => {
        const attendeeId = await bookedWithPayment("sess-q", "pi_already_back");
        await execute(
          "UPDATE processed_payments SET provider_refunded_at = ? WHERE payment_session_id = ?",
          [new Date(nowMs()).toISOString(), "sess-q"],
        );
        const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([
          await paymentReferenceIndex(
            taggedPaymentReference("pi_already_back"),
          ),
        ]);
      });

      test("names a reference a sharing row says came back", async () => {
        const ours = await bookedWithPayment("sess-s1", "pi_shared_back");
        await bookedWithPayment("sess-s2", "pi_shared_back");
        await execute(
          "UPDATE processed_payments SET provider_refunded_at = ? WHERE payment_session_id = ?",
          [new Date(nowMs()).toISOString(), "sess-s2"],
        );
        const held = await claimCurrentAttendeeRows([ours], "keyless");
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([
          await paymentReferenceIndex(taggedPaymentReference("pi_shared_back")),
        ]);
      });

      test("names nothing while the money is still out", async () => {
        const attendeeId = await bookedWithPayment("sess-r", "pi_still_out");
        const held = await claimCurrentAttendeeRows([attendeeId], "keyless");
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([]);
      });
    });
  },
);
