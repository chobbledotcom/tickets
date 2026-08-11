/** Taking an all-or-none hold on the exact refund snapshot an admin loaded. */

/* jscpd:ignore-start -- imports */
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  type AnchoredAttendee,
  legacyAnchorStatements,
} from "#shared/db/payment-anchor/mint.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  asPaymentRowRecord,
  paymentRowStateStatement,
  readPaymentClaimRows,
  type StoredPaymentClaimRow,
} from "#shared/db/payment-claim.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import {
  type ClaimDecision,
  claimLeaseMs,
  decideClaim,
  holdsTheRow,
} from "#shared/payment/claim.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

/** What happened when a run asked for an attendee's rows. */
export type ClaimResult =
  | { blockedBy: ClaimDecision; kind: "blocked" }
  | { kind: "changed" }
  | {
      /** Each attendee's claimed rows, kept apart so a run can let one
       *  attendee go while another's answer is still in doubt. */
      held: ReadonlyMap<number, readonly string[]>;
      heldSince: string;
      kind: "claimed";
      /** Attendees inheriting a crashed run's doubt, under that run's own
       *  provider capability. */
      inherited: ReadonlyMap<number, RefundCapability>;
      /** References a claimed or sharing row already says came back. */
      returned: ReadonlySet<string>;
    };

/** The exact attendee and payment-reference snapshot an admin run loaded.
 *  `loadedPiiBlob` is the attendee revision: payment_id lives inside it, so a
 *  concurrent edit cannot make a legacy anchor preserve a stale charge. */
export type LoadedRefundAttendee = AnchoredAttendee & {
  readonly loadedPiiBlob: string;
};

type StoredAttendee = {
  id: number;
  pii_blob: string;
};

type ExpectedPaymentRow = {
  attendeeId: number;
  referenceIndex: string;
};

/** Every row holding these attendees' refundable money, plus other rows that
 *  carry the same provider reference. */
const readClaimableRows = async (
  tx: TxScope,
  attendeeIds: readonly number[],
): Promise<{
  own: StoredPaymentClaimRow[];
  sharing: StoredPaymentClaimRow[];
}> => {
  const own = await readPaymentClaimRows(
    tx,
    `attendee_id IN (${inPlaceholders(
      attendeeIds,
    )}) AND payment_reference != ''`,
    [...attendeeIds],
  );
  const indexes = own
    .map((row) => row.payment_reference_index)
    .filter((index) => index !== "");
  if (indexes.length === 0) return { own, sharing: [] };
  const sharing = await readPaymentClaimRows(
    tx,
    `attendee_id NOT IN (${inPlaceholders(attendeeIds)})
       AND payment_reference_index IN (${inPlaceholders(indexes)})`,
    [...attendeeIds, ...indexes],
  );
  return { own, sharing };
};

/** Row identities the loaded snapshot says the run must hold. A row-less
 *  charge names the deterministic anchor this transaction will mint. */
const expectedRowsBySession = (
  attendees: readonly LoadedRefundAttendee[],
): ReadonlyMap<string, ExpectedPaymentRow> =>
  new Map(
    attendees.flatMap((attendee) =>
      attendee.references.flatMap((reference) => {
        const sessionIds =
          reference.rowSessionIds.length > 0
            ? reference.rowSessionIds
            : [anchorSessionId(attendee.attendeeId, reference.index)];
        return sessionIds.map(
          (sessionId) =>
            [
              sessionId,
              {
                attendeeId: attendee.attendeeId,
                referenceIndex: reference.index,
              },
            ] as const,
        );
      }),
    ),
  );

const attendeesMatch = (
  loaded: readonly LoadedRefundAttendee[],
  stored: readonly StoredAttendee[],
): boolean => {
  if (loaded.length !== stored.length) return false;
  const loadedById = new Map(
    loaded.map((attendee) => [attendee.attendeeId, attendee.loadedPiiBlob]),
  );
  return stored.every((attendee) => {
    const loadedPiiBlob = loadedById.get(Number(attendee.id));
    return loadedPiiBlob !== undefined && loadedPiiBlob === attendee.pii_blob;
  });
};

const rowsMatch = (
  expected: ReadonlyMap<string, ExpectedPaymentRow>,
  stored: readonly StoredPaymentClaimRow[],
): boolean => {
  if (expected.size !== stored.length) return false;
  return stored.every((row) => {
    const loaded = expected.get(row.payment_session_id);
    return (
      loaded !== undefined &&
      loaded.attendeeId === Number(row.attendee_id) &&
      loaded.referenceIndex === row.payment_reference_index
    );
  });
};

const claimCapability = (
  inherited: ReadonlyMap<number, RefundCapability>,
  attendeeId: number,
  current: RefundCapability,
): RefundCapability => {
  const original = inherited.get(attendeeId);
  return original === undefined ? current : original;
};

/** Claim every row in the loaded snapshot, or none. Legacy anchors, attendee
 *  revision checks, row-set checks, and holds share one write transaction. */
export const claimAttendeeRows = async (
  attendees: readonly LoadedRefundAttendee[],
  capability: RefundCapability,
): Promise<ClaimResult> => {
  if (attendees.length === 0) {
    return {
      held: new Map(),
      heldSince: nowIso(),
      inherited: new Map(),
      kind: "claimed",
      returned: new Set(),
    };
  }
  const attendeeIds = attendees.map((attendee) => attendee.attendeeId);
  const expected = expectedRowsBySession(attendees);
  const anchors = await legacyAnchorStatements(attendees);
  const writtenAt = nowIso();
  const staleBefore = isoBefore(claimLeaseMs(STALE_RESERVATION_MS));
  return await withTransaction(async (tx) => {
    const attendeeRead = await tx.execute({
      args: [...attendeeIds],
      sql: `SELECT attendee.id, attendee.pii_blob
              FROM attendees AS attendee
             WHERE attendee.id IN (${inPlaceholders(attendeeIds)})`,
    });
    if (!attendeesMatch(attendees, resultRows<StoredAttendee>(attendeeRead))) {
      return { kind: "changed" };
    }
    if (anchors.length > 0) await tx.batch(anchors);
    const stored = await readClaimableRows(tx, attendeeIds);
    if (!rowsMatch(expected, stored.own)) return { kind: "changed" };
    const rows = await Promise.all(stored.own.map(asPaymentRowRecord));
    // Write transactions serialize, so a rival committed before this read or
    // cannot begin until this run commits.
    const sharing = await Promise.all(stored.sharing.map(asPaymentRowRecord));
    const judged = rows.map((row) => ({
      decision: decideClaim(
        row.state.claim,
        { attendeeId: row.attendeeId, scope: "attendee_set" },
        staleBefore,
      ),
      row,
    }));
    const refused = judged.find(({ decision }) => !holdsTheRow(decision));
    if (refused !== undefined) {
      return { blockedBy: refused.decision, kind: "blocked" };
    }
    // We cannot take over somebody else's row, even when their hold is stale.
    if (sharing.some((row) => row.state.claim !== undefined)) {
      return { blockedBy: { kind: "foreign" }, kind: "blocked" };
    }
    const inherited = new Map(
      judged.flatMap(({ decision, row }) =>
        decision.kind === "resume"
          ? [[row.attendeeId, decision.resuming.capability] as const]
          : [],
      ),
    );
    await tx.batch(
      await Promise.all(
        rows.map((row) =>
          paymentRowStateStatement(row, {
            ...row.state,
            claim: {
              attendeeId: row.attendeeId,
              capability: claimCapability(
                inherited,
                row.attendeeId,
                capability,
              ),
              scope: "attendee_set",
              writtenAt,
            },
          }),
        ),
      ),
    );
    return {
      held: new Map(
        [...Map.groupBy(rows, (row) => row.attendeeId)].map(
          ([attendeeId, owned]) => [
            attendeeId,
            owned.map((row) => row.sessionId),
          ],
        ),
      ),
      heldSince: writtenAt,
      inherited,
      kind: "claimed",
      returned: new Set(
        [...stored.own, ...stored.sharing]
          .filter((row) => row.provider_refunded_at !== "")
          .map((row) => row.payment_reference_index),
      ),
    };
  });
};
