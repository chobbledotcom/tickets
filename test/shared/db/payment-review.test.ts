import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, withTransaction } from "#shared/db/client.ts";
import {
  type PaymentRowRecord,
  readAttendeeRowStates,
} from "#shared/db/payment-claim.ts";
import {
  getPaymentWorkStatus,
  resolvePaymentReview,
} from "#shared/db/payment-review.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import type {
  PaymentRowState,
  RefundCapability,
} from "#shared/payment/row-state.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  protectedStateOf,
  putRowState,
  REVIEW_MIRROR,
  rowStateSlot,
  storedRecordOf,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
} from "#test-utils/processed-payments.ts";

const LISTING_ID = 1;
const REVIEW_ACTIVITY = "Payment marked reviewed by owner";
const OWNER_RESOLVED_ERROR = "Payment review resolved by the owner";

const stateRows = (attendeeId: number): Promise<PaymentRowRecord[]> =>
  withTransaction((tx) => readAttendeeRowStates(tx, [attendeeId]));

const stateBySession = async (
  attendeeId: number,
): Promise<ReadonlyMap<string, PaymentRowState>> =>
  new Map(
    (await stateRows(attendeeId)).map((row) => [row.sessionId, row.state]),
  );

const claimState = (
  attendeeId: number,
  capability: RefundCapability,
  { review = false, stale = false }: { review?: boolean; stale?: boolean } = {},
): PaymentRowState => ({
  claim: {
    attendeeId,
    capability,
    scope: "attendee_set",
    writtenAt: new Date(
      nowMs() - (stale ? STALE_RESERVATION_MS + 1000 : 0),
    ).toISOString(),
  },
  ...(review ? { review: { kind: "partial_refund" } as const } : {}),
});

const resolve = (attendeeId: number) =>
  resolvePaymentReview({ attendeeId, listingId: LISTING_ID });

describeWithEnv(
  "db > resolving a payment review",
  { db: true, encryptionKey: true },
  () => {
    test("summarizes whether owner-review work is actionable", async () => {
      const attendeeId = await bookedWithPayment("sess-status", "pi_status");

      expect(await getPaymentWorkStatus(attendeeId)).toBe("clear");

      await putRowState(
        "sess-status",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");

      await putRowState(
        "sess-status",
        await rowStateSlot(claimState(attendeeId, "keyed", { review: true })),
        CLAIM_MIRROR,
      );
      expect(await getPaymentWorkStatus(attendeeId)).toBe("moving");

      await putRowState(
        "sess-status",
        await rowStateSlot(
          claimState(attendeeId, "unresolved", { stale: true }),
        ),
        CLAIM_MIRROR,
      );
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_review");
    });

    test("retires reviews while preserving terminal and unrecorded facts", async () => {
      const attendeeId = await bookedWithPayment("sess-review", "pi_review");
      await putRowState(
        "sess-review",
        await rowStateSlot({
          outcome: { error: "Existing outcome", refunded: true, status: 409 },
          review: { kind: "partial_refund" },
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
        REVIEW_MIRROR,
      );

      expect(await resolve(attendeeId)).toEqual({ kind: "resolved" });
      expect(await getPaymentWorkStatus(attendeeId)).toBe("needs_money_record");

      expect(await stateBySession(attendeeId)).toEqual(
        new Map([
          [
            "sess-review",
            {
              outcome: {
                error: "Existing outcome",
                refunded: true,
                status: 409,
              },
              unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
            },
          ],
        ]),
      );
      expect(await protectedStateOf("sess-review")).toBe(UNRECORDED_MIRROR);
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([
        expect.objectContaining({
          attendee_id: attendeeId,
          listing_id: LISTING_ID,
          message: REVIEW_ACTIVITY,
        }),
      ]);
    });

    test("turns a stale unresolved claim into a terminal owner outcome", async () => {
      const attendeeId = await bookedWithPayment("sess-stale", "pi_stale");
      await putRowState(
        "sess-stale",
        await rowStateSlot(
          claimState(attendeeId, "unresolved", {
            review: true,
            stale: true,
          }),
        ),
        CLAIM_MIRROR,
      );

      expect(await resolve(attendeeId)).toEqual({ kind: "resolved" });
      expect(await stateBySession(attendeeId)).toEqual(
        new Map([["sess-stale", { outcome: { error: OWNER_RESOLVED_ERROR } }]]),
      );
      expect(await protectedStateOf("sess-stale")).toBe("");
    });

    test("does not overwrite an existing outcome on a stale unresolved claim", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-stale-outcome",
        "pi_stale_outcome",
      );
      await putRowState(
        "sess-stale-outcome",
        await rowStateSlot({
          ...claimState(attendeeId, "unresolved", { stale: true }),
          outcome: { error: "First outcome", status: 400 },
        }),
        CLAIM_MIRROR,
      );

      expect(await resolve(attendeeId)).toEqual({ kind: "resolved" });
      expect(await stateBySession(attendeeId)).toEqual(
        new Map([
          [
            "sess-stale-outcome",
            { outcome: { error: "First outcome", status: 400 } },
          ],
        ]),
      );
    });

    const blockedClaims: readonly [string, RefundCapability, boolean][] = [
      ["fresh unresolved", "unresolved", false],
      ["fresh keyed", "keyed", false],
      ["fresh keyless", "keyless", false],
      ["stale keyed", "keyed", true],
      ["stale keyless", "keyless", true],
    ];
    for (const [name, capability, stale] of blockedClaims) {
      test(`refuses a ${name} claim without changing or logging`, async () => {
        const sessionId = `sess-block-${capability}-${stale}`;
        const attendeeId = await bookedWithPayment(
          sessionId,
          `pi-block-${capability}-${stale}`,
        );
        await putRowState(
          sessionId,
          await rowStateSlot(
            claimState(attendeeId, capability, { review: true, stale }),
          ),
          CLAIM_MIRROR,
        );
        const before = await storedRecordOf(sessionId);

        expect(await resolve(attendeeId)).toEqual({
          kind: "claim_in_progress",
        });
        expect(await storedRecordOf(sessionId)).toBe(before);
        expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
      });
    }

    test("a blocked sibling leaves the attendee's review untouched", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-sibling-review",
        "pi_sibling_review",
      );
      await finalizeProcessedPayment(
        "sess-sibling-claim",
        attendeeId,
        "tok-sibling",
      );
      await putRowState(
        "sess-sibling-review",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );
      await putRowState(
        "sess-sibling-claim",
        await rowStateSlot(claimState(attendeeId, "keyed")),
        CLAIM_MIRROR,
      );

      expect(await resolve(attendeeId)).toEqual({
        kind: "claim_in_progress",
      });
      expect(await protectedStateOf("sess-sibling-review")).toBe(REVIEW_MIRROR);
    });

    test("returns nothing to review without writing an activity", async () => {
      const attendeeId = await bookedWithPayment("sess-none", "pi_none");

      expect(await resolve(attendeeId)).toEqual({
        kind: "nothing_to_review",
      });
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("two concurrent confirmations resolve and log exactly once", async () => {
      const attendeeId = await bookedWithPayment("sess-race", "pi_race");
      await putRowState(
        "sess-race",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );

      const results = await Promise.all([
        resolve(attendeeId),
        resolve(attendeeId),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual([
        "nothing_to_review",
        "resolved",
      ]);
      expect(
        (await getAttendeeActivityLog(attendeeId)).map(
          (entry) => entry.message,
        ),
      ).toEqual([REVIEW_ACTIVITY]);
    });

    test("a missed row write rolls the whole resolution back", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-cas-first",
        "pi_cas_first",
      );
      await finalizeProcessedPayment(
        "sess-cas-lost",
        attendeeId,
        "tok-cas-lost",
      );
      for (const sessionId of ["sess-cas-first", "sess-cas-lost"]) {
        await putRowState(
          sessionId,
          await rowStateSlot({ review: { kind: "partial_refund" } }),
          REVIEW_MIRROR,
        );
      }
      await execute(
        `CREATE TRIGGER ignore_payment_review
          BEFORE UPDATE ON processed_payments
          WHEN OLD.payment_session_id = 'sess-cas-lost'
          BEGIN SELECT RAISE(IGNORE); END`,
      );

      await expect(resolve(attendeeId)).rejects.toThrow(
        "Payment review no longer owns payment row sess-cas-lost",
      );

      expect(await protectedStateOf("sess-cas-first")).toBe(REVIEW_MIRROR);
      expect(await protectedStateOf("sess-cas-lost")).toBe(REVIEW_MIRROR);
      expect(await getAttendeeActivityLog(attendeeId)).toEqual([]);
    });

    test("an activity-log failure leaves the review in place", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-log-failure",
        "pi_log_failure",
      );
      await putRowState(
        "sess-log-failure",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );
      await execute(
        `CREATE TRIGGER refuse_payment_review_activity
          BEFORE INSERT ON activity_log
          BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`,
      );

      await expect(resolve(attendeeId)).rejects.toThrow("activity unavailable");

      expect(await protectedStateOf("sess-log-failure")).toBe(REVIEW_MIRROR);
    });

    test("changes only the named attendee's exact payment rows", async () => {
      const named = await bookedWithPayment("sess-named", "pi_named");
      const other = await bookedWithPayment("sess-other", "pi_other");
      await putRowState(
        "sess-named",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );
      await putRowState(
        "sess-other",
        await rowStateSlot({ review: { kind: "partial_refund" } }),
        REVIEW_MIRROR,
      );

      expect(await resolve(named)).toEqual({ kind: "resolved" });

      expect(await protectedStateOf("sess-named")).toBe("");
      expect(await protectedStateOf("sess-other")).toBe(REVIEW_MIRROR);
      expect(await getAttendeeActivityLog(other)).toEqual([]);
    });
  },
);
