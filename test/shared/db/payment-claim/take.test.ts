import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  heldSessionIds,
  makeClaimsStale,
  protectedStateOf,
  putRowState,
  referenceIndexOf,
  releaseClaimRows,
  rowStateSlot,
  staleClaimSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
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
        const result = await claimCurrentAttendeeRows([attendeeId]);
        if (result.kind !== "claimed") throw new Error("the claim was refused");
        expect(heldSessionIds(result)).toEqual(["sess-a"]);
        expect([...result.held.keys()]).toEqual([attendeeId]);
      });

      test("the claim shows in the plaintext mirror", async () => {
        const attendeeId = await bookedWithPayment("sess-b", "pi_b");
        const held = await claimCurrentAttendeeRows([attendeeId]);
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(held.heldSince).not.toBe("");
        expect(await protectedStateOf("sess-b")).toBe(CLAIM_MIRROR);
      });

      test("a second run is told the work is in progress", async () => {
        const attendeeId = await bookedWithPayment("sess-c", "pi_c");
        await claimCurrentAttendeeRows([attendeeId]);
        expect(await claimCurrentAttendeeRows([attendeeId])).toEqual({
          blockedBy: { kind: "held" },
          kind: "blocked",
        });
      });

      test("two concurrent runs on one attendee have one winner", async () => {
        const attendeeId = await bookedWithPayment("sess-d", "pi_d");
        const results = await Promise.all([
          claimCurrentAttendeeRows([attendeeId]),
          claimCurrentAttendeeRows([attendeeId]),
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

        const held = await claimCurrentAttendeeRows([first]);
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(heldSessionIds(held).sort()).toEqual(["sess-e1", "sess-e2"]);
        expect(
          [...held.shared.values()]
            .flat()
            .map(({ sessionId }) => sessionId)
            .sort(),
        ).toEqual(["sess-e1", "sess-e2"]);
        expect(await claimCurrentAttendeeRows([second])).toEqual({
          blockedBy: { kind: "held" },
          kind: "blocked",
        });
      });

      test("concurrent shared-reference claims have one winner", async () => {
        const first = await bookedWithPayment("sess-f1", "pi_race");
        const second = await bookedWithPayment("sess-f2", "pi_race");
        const results = await Promise.all([
          claimCurrentAttendeeRows([first]),
          claimCurrentAttendeeRows([second]),
        ]);
        expect(
          results.filter((result) => result.kind === "claimed"),
        ).toHaveLength(1);
      });

      test("an unrelated attendee remains free", async () => {
        const first = await bookedWithPayment("sess-g1", "pi_g1");
        const second = await bookedWithPayment("sess-g2", "pi_g2");
        await claimCurrentAttendeeRows([first]);
        const secondClaim = await claimCurrentAttendeeRows([second]);
        if (secondClaim.kind !== "claimed") {
          throw new Error("the claim was refused");
        }
        expect(heldSessionIds(secondClaim)).toEqual(["sess-g2"]);
      });

      test("claiming nobody reaches no database", async () => {
        const calls = await countDatabaseCalls(0, async () => {
          const nobody = await claimCurrentAttendeeRows([]);
          if (nobody.kind !== "claimed") {
            throw new Error("the claim was refused");
          }
          expect(heldSessionIds(nobody)).toEqual([]);
        });
        expect(calls).toBe(0);
      });

      test("an attendee with no refundable rows claims an empty set", async () => {
        const listing = await createTestListing();
        const booked = await bookAttendee(listing, {
          email: "no-payment@example.com",
          name: "No Payment",
        });
        const attendeeId = bookedAttendee(booked).id;

        const result = await claimCurrentAttendeeRows([attendeeId]);

        if (result.kind !== "claimed") throw new Error("the claim was refused");
        expect(heldSessionIds(result)).toEqual([]);
      });

      test("a missing attendee fails at the snapshot boundary", async () => {
        await expect(claimCurrentAttendeeRows([-1])).rejects.toThrow(
          "Attendee -1 was not found before the claim",
        );
      });

      test("an attendee deleted after loading changes the whole claim", async () => {
        const first = await bookedWithPayment("sess-deleted-first", "pi_first");
        const deleted = await bookedWithPayment(
          "sess-deleted-second",
          "pi_second",
        );

        const result = await claimCurrentAttendeeRows(
          [first, deleted],
          async () => {
            await execute("DELETE FROM attendees WHERE id = ?", [deleted]);
          },
        );

        expect(result).toEqual({ kind: "changed" });
        expect(await protectedStateOf("sess-deleted-first")).toBe("");
      });

      test("an attendee save after loading changes the whole claim", async () => {
        const attendeeId = await bookedWithPayment(
          "sess-changed-attendee",
          "pi_changed_attendee",
        );
        const replacement = await bookedWithPayment(
          "sess-replacement-attendee",
          "pi_replacement_attendee",
        );

        const result = await claimCurrentAttendeeRows(
          [attendeeId],
          async () => {
            await execute(
              `UPDATE attendees
                SET pii_blob = (
                  SELECT replacement.pii_blob
                    FROM attendees AS replacement
                   WHERE replacement.id = ?
                )
              WHERE id = ?`,
              [replacement, attendeeId],
            );
          },
        );

        expect(result).toEqual({ kind: "changed" });
        expect(await protectedStateOf("sess-changed-attendee")).toBe("");
      });

      test("a payment row deleted after loading changes the whole claim", async () => {
        const attendeeId = await bookedWithPayment(
          "sess-deleted-payment",
          "pi_deleted_payment",
        );

        const result = await claimCurrentAttendeeRows(
          [attendeeId],
          async () => {
            await execute(
              "DELETE FROM processed_payments WHERE payment_session_id = ?",
              ["sess-deleted-payment"],
            );
          },
        );

        expect(result).toEqual({ kind: "changed" });
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

        const held = await claimCurrentAttendeeRows([attendeeId]);

        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect(held.unrecorded).toEqual(
          new Map([[attendeeId, ["sess-unrecorded"]]]),
        );
      });

      test("names a reference whose canonical charge says came back", async () => {
        const attendeeId = await bookedWithPayment("sess-q", "pi_already_back");
        await markProviderRefundsReturned(
          await getCompleteRefundPaymentReferencesForAttendee({
            currentPaymentId: "pi_already_back",
            id: attendeeId,
          }),
        );
        const held = await claimCurrentAttendeeRows([attendeeId]);
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([
          await paymentReferenceIndex(
            taggedPaymentReference("pi_already_back"),
          ),
        ]);
      });

      test("names a returned reference represented by a sharing row", async () => {
        const ours = await bookedWithPayment("sess-s1", "pi_shared_back");
        await bookedWithPayment("sess-s2", "pi_shared_back");
        await markProviderRefundsReturned(
          await getCompleteRefundPaymentReferencesForAttendee({
            currentPaymentId: "pi_shared_back",
            id: ours,
          }),
        );
        const held = await claimCurrentAttendeeRows([ours]);
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([
          await paymentReferenceIndex(taggedPaymentReference("pi_shared_back")),
        ]);
      });

      test("names nothing while the money is still out", async () => {
        const attendeeId = await bookedWithPayment("sess-r", "pi_still_out");
        const held = await claimCurrentAttendeeRows([attendeeId]);
        if (held.kind !== "claimed") throw new Error("the claim was refused");
        expect([...held.returned]).toEqual([]);
      });
    });
  },
);
