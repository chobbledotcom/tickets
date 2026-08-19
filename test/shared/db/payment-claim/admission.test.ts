import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireOne } from "#db/client.ts";
import { claimRequestFor } from "#db/payment-claim/scope.ts";
import {
  claimAttendeeRows,
  type LoadedRefundAttendee,
} from "#db/payment-claim/take.ts";
import { getRefundPaymentReferences } from "#db/payment-references.ts";
import { requiredMapValue } from "#fp";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
} from "#test-utils/payment-claim.ts";
import { requireCompleteRefundReferences } from "#test-utils/payment-references.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

type StoredAttendee = { pii_blob: string };

const loadedAttendee = async (
  attendeeId: number,
): Promise<LoadedRefundAttendee> => {
  const attendee = await requireOne<StoredAttendee>(
    "SELECT pii_blob FROM attendees WHERE id = ?",
    [attendeeId],
  );
  const referenceSets = await getRefundPaymentReferences(
    [{ currentPaymentId: "", id: attendeeId }],
    await getTestPrivateKey(),
  );
  return {
    attendeeId,
    loadedPiiBlob: attendee.pii_blob,
    references: requireCompleteRefundReferences(
      requiredMapValue(
        referenceSets,
        attendeeId,
        `Attendee ${attendeeId}'s payment references were not loaded`,
      ),
    ),
  };
};

describeWithEnv(
  "db > payment claim admission",
  { db: true, encryptionKey: true },
  () => {
    test("an empty command can be refused before opening a transaction", async () => {
      const calls = await countDatabaseCalls(0, async () => {
        expect(
          await claimAttendeeRows([], ({ attendees, returned }) => {
            expect(attendees).toEqual([]);
            expect(returned).toEqual(new Set());
            return false;
          }),
        ).toEqual({ kind: "not_admitted" });
      });

      expect(calls).toBe(0);
    });

    test("a refused exact row set is left unclaimed", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-admission-refused",
        "pi_admission_refused",
      );
      const loaded = await loadedAttendee(attendeeId);

      const result = await claimAttendeeRows([loaded], (facts) => {
        expect(facts.attendees).toEqual([loaded]);
        expect(facts.returned).toEqual(new Set());
        return false;
      });

      expect(result).toEqual({ kind: "not_admitted" });
      expect(await protectedStateOf("sess-admission-refused")).toBe("");
      expect(await claimCurrentAttendeeRows([attendeeId])).toMatchObject({
        kind: "claimed",
      });
    });

    test("a stored row must belong to one initiating reference", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-admission-scope",
        "pi_admission_scope",
      );
      const loaded = await loadedAttendee(attendeeId);

      expect(() =>
        claimRequestFor([loaded], {
          referenceIndex: "unrelated-reference-index",
          sessionId: "unrelated-session",
        }),
      ).toThrow(/^Payment row matched no initiating attendee$/u);
    });

    test("a row added after loading changes the exact payment set", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-admission-original",
        "pi_admission_original",
      );
      const loaded = await loadedAttendee(attendeeId);
      await finalizeProcessedPayment(
        "sess-admission-added",
        attendeeId,
        "tok-admission-added",
      );

      expect(await claimAttendeeRows([loaded])).toEqual({ kind: "changed" });
      expect(await protectedStateOf("sess-admission-original")).toBe("");
      expect(await protectedStateOf("sess-admission-added")).toBe("");
    });

    test("a claim carries the exact review reason it found", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-admission-review",
        "pi_admission_review",
      );
      await putRowState(
        "sess-admission-review",
        await rowStateSlot({
          review: reviewCase(
            { kind: "partially_returned_obligation" },
            "admission-review-case",
          ),
        }),
        REVIEW_MIRROR,
      );

      const result = await claimCurrentAttendeeRows([attendeeId]);

      expect(result).toMatchObject({
        kind: "claimed",
        reviews: new Map([
          ["sess-admission-review", { kind: "partially_returned_obligation" }],
        ]),
      });
    });
  },
);
