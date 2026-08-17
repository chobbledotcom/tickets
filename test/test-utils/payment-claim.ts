/** Building the stored records a refund claim reads, for tests that need a row
 *  to already be in a particular state. */

import { assert } from "@std/assert";
import { requiredMapValue } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  inPlaceholders,
  queryAll,
  requireOne,
} from "#shared/db/client.ts";
import {
  type ClaimResult,
  claimAttendeeRows,
} from "#shared/db/payment-claim/take.ts";
import { settleAttendeeRows } from "#shared/db/payment-claim.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { mirrorFor } from "#shared/payment/admit-move.ts";
import type {
  PaymentReviewCase,
  PaymentReviewReason,
} from "#shared/payment/review.ts";
import type {
  PaymentRowState,
  RefundClaim,
} from "#shared/payment/row-state.ts";
import { readRowState, writeRowState } from "#shared/payment/row-state.ts";
import type { PaymentRowSettlement } from "#shared/payment/row-transitions.ts";
import { getCompleteRefundPaymentReferences } from "#test-utils/payment-references.ts";

const SLOT = "processed_payments.failure_data";

type StoredClaimAttendee = {
  id: number;
  pii_blob: string;
};

/** Load the same exact snapshot as an admin refund and claim it. Most claim
 *  tests care about claim behaviour after the load, so this keeps the real
 *  reference/index/revision boundary out of every fixture. */
export const claimCurrentAttendeeRows = async (
  attendeeIds: readonly number[],
  beforeClaim: () => Promise<void> = () => Promise.resolve(),
): Promise<ClaimResult> => {
  if (attendeeIds.length === 0) return claimAttendeeRows([]);
  const stored = await queryAll<StoredClaimAttendee>(
    `SELECT attendee.id, attendee.pii_blob
       FROM attendees AS attendee
      WHERE attendee.id IN (${inPlaceholders(attendeeIds)})`,
    [...attendeeIds],
  );
  const storedById = new Map(stored.map((attendee) => [attendee.id, attendee]));
  const sources = attendeeIds.map((id) => ({
    id,
    payment_id: "",
  }));
  const references = await getCompleteRefundPaymentReferences(sources);
  const loadedAttendees = sources.map(({ id }) => {
    const attendee = requiredMapValue(
      storedById,
      id,
      `Attendee ${id} was not found before the claim`,
    );
    const loaded = requiredMapValue(
      references,
      id,
      `Attendee ${id}'s payment references were not loaded`,
    );
    return {
      attendeeId: id,
      loadedPiiBlob: attendee.pii_blob,
      references: loaded,
    };
  });
  await beforeClaim();
  return await claimAttendeeRows(loadedAttendees);
};

/** The plain words the prune and the orphan purge see, read back out of the
 *  production table rather than spelled again here — so a change to either word
 *  moves every fixture and assertion with it. */
export const CLAIM_MIRROR = mirrorFor({
  claim: {
    attendeeIds: [1],
    commandId: "test-command",
    phase: "checking",
    scope: "attendee_set",
    writtenAt: "",
  },
});
export const reviewCase = (
  reason: PaymentReviewReason,
  caseId = `case-${reason.kind}`,
): PaymentReviewCase => ({ caseId, reason });

export const REVIEW_MIRROR = mirrorFor({
  review: reviewCase({ kind: "partially_returned_obligation" }),
});
export const UNRECORDED_MIRROR = mirrorFor({
  unrecorded: { returnedAt: "" },
});

/** One column off a payment row, by the session that names it. Every caller
 *  has just written the row it asks about, so a missing one is a broken test:
 *  `requireOne` names the failed query rather than handing back a null for the
 *  assertion to trip over further along. */
const paymentRowColumn =
  (column: string) =>
  async (sessionId: string): Promise<string> =>
    (
      await requireOne<{ v: string }>(
        `SELECT payment.${column} AS v
           FROM processed_payments AS payment
          WHERE payment.payment_session_id = ?`,
        [sessionId],
      )
    ).v;

/** The plain word the row shows the readers that cannot decrypt it. */
export const protectedStateOf = paymentRowColumn("protected_state");

/** The blind one-way index stored beside the row's payment reference. */
export const referenceIndexOf = paymentRowColumn("payment_reference_index");

/** The stored record itself, still encrypted. Compared between two calls it
 *  shows whether a writer left the row alone: a rewrite would carry a fresh
 *  time and fresh ciphertext even for the same facts. */
export const storedRecordOf = paymentRowColumn("failure_data");

/** Age the exact claims a run wrote without changing who or what they name. */
export const makeClaimsStale = async (
  sessionIds: readonly string[],
): Promise<void> => {
  for (const sessionId of sessionIds) {
    const stored = await requireOne<{ failure_data: EnvKeyEncrypted }>(
      `SELECT payment.failure_data
         FROM processed_payments AS payment
        WHERE payment.payment_session_id = ?`,
      [sessionId],
    );
    const state = readRowState(await decrypt(stored.failure_data), SLOT);
    assert(
      state.claim !== undefined,
      `Payment row ${sessionId} has no claim to age`,
    );
    await putRowState(
      sessionId,
      await rowStateSlot({
        ...state,
        claim: {
          ...state.claim,
          writtenAt: new Date(
            nowMs() - STALE_RESERVATION_MS - 1000,
          ).toISOString(),
        },
      }),
      mirrorFor(state),
    );
  }
};

/** Any record, encrypted the way the column stores it. */
export const rowStateSlot = (state: PaymentRowState): Promise<string> =>
  encrypt(writeRowState(state, SLOT));

/** One `attendee_set` claim's record, written the given number of milliseconds
 *  ago. Curried so "a run holding this now" and "a crashed worker's" are the
 *  same record differing only in age. */
export type ClaimFixturePhase = "checking";

export const refundClaimFixture = (
  attendeeId: number,
  phase: ClaimFixturePhase,
  writtenAt: string,
): RefundClaim => {
  const common = {
    attendeeIds: [attendeeId],
    commandId: `test-command-${attendeeId}`,
    scope: "attendee_set" as const,
    writtenAt,
  };
  return { ...common, phase };
};

const claimSlotWritten =
  (msAgo: number) =>
  (
    attendeeId: number,
    phase: ClaimFixturePhase = "checking",
  ): Promise<string> =>
    rowStateSlot({
      claim: refundClaimFixture(
        attendeeId,
        phase,
        new Date(nowMs() - msAgo).toISOString(),
      ),
    });

/** The stored record for a claim a run is holding right now. */
export const freshClaimSlot = claimSlotWritten(0);

/** The stored record for a claim written long enough ago to be a crashed
 *  worker's. */
export const staleClaimSlot = claimSlotWritten(STALE_RESERVATION_MS + 1000);

/** Put a record on an existing payment row, mirror and all, the way a claim or
 *  an owner review leaves it. */
export const putRowState = async (
  sessionId: string,
  slot: string,
  mirror: string,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments
        SET failure_data = ?, protected_state = ?
      WHERE payment_session_id = ?`,
    [slot, mirror, sessionId],
  );
};

/** Every row a claim holds, flattened for tests that only care which exact
 * payment rows the checking fence covered. */
export const heldSessionIds = (claim: {
  held: ReadonlyMap<number, readonly string[]>;
}): string[] => [...claim.held.values()].flat();

/** Release exact rows under the claim a test just took. */
export const releaseClaimRows = (
  claim: {
    commandId: string;
    heldSince: string;
    phases: ReadonlyMap<string, RefundClaim["phase"]>;
  },
  sessionIds: readonly string[],
  changes: ReadonlyMap<
    string,
    Omit<PaymentRowSettlement, "claim" | "phase">
  > = new Map(),
): Promise<void> =>
  settleAttendeeRows({
    commandId: claim.commandId,
    heldSince: claim.heldSince,
    rows: new Map(
      sessionIds.map((sessionId) => [
        sessionId,
        {
          ...changes.get(sessionId),
          claim: "release",
          phase: requiredMapValue(
            claim.phases,
            sessionId,
            `Test claim lost payment-row phase ${sessionId}`,
          ),
        } as const,
      ]),
    ),
  });
