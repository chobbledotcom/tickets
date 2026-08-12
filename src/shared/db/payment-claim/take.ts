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
  type PaymentRowRecord,
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
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import type {
  RefundCapability,
  ResolvedRefundCapability,
} from "#shared/payment/row-state.ts";
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
      /** References inheriting a crashed run's doubt, under that reference's
       *  own provider capability and grouped for attendee-wide settlement. */
      inherited: InheritedRefundCapabilities;
      /** References a claimed or sharing row already says came back. */
      returned: ReadonlySet<string>;
      /** Owner-review reasons carried by each claimed row. */
      reviews: ReadonlyMap<string, PaymentReviewReason>;
      /** References represented by more than one exact payment row. */
      shared: ReadonlyMap<string, readonly PaymentReferenceRepresentation[]>;
      /** Claimed rows that already say returned money is missing from the
       *  books. A failed readiness check must not erase this repair target. */
      unrecorded: ReadonlyMap<number, readonly string[]>;
    };

/** The exact attendee and payment-reference snapshot an admin run loaded.
 *  `loadedPiiBlob` is the attendee revision: payment_id lives inside it, so a
 *  concurrent edit cannot make a legacy anchor preserve a stale charge. */
export type LoadedRefundAttendee = AnchoredAttendee & {
  readonly loadedPiiBlob: string;
};

/** One exact durable row that represents a provider charge. */
export type PaymentReferenceRepresentation = {
  readonly attendeeId: number;
  readonly index: string;
  readonly sessionId: string;
};

/** Provider retry facts inherited by each attendee and exact reference. */
export type InheritedRefundCapabilities = ReadonlyMap<
  number,
  ReadonlyMap<string, ResolvedRefundCapability>
>;

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
  matchingIndexes: readonly string[],
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
  const indexes = [...new Set(matchingIndexes)].filter((index) => index !== "");
  if (indexes.length === 0) return { own, sharing: [] };
  const sharing = await readPaymentClaimRows(
    tx,
    `attendee_id NOT IN (${inPlaceholders(attendeeIds)})
       AND payment_reference_index IN (${inPlaceholders(indexes)})`,
    [...attendeeIds, ...indexes],
  );
  return { own, sharing };
};

const matchingIndexesOf = (
  attendees: readonly LoadedRefundAttendee[],
): string[] =>
  attendees.flatMap(({ references }) =>
    references.flatMap(({ matchingIndexes }) => matchingIndexes),
  );

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
  inherited: InheritedRefundCapabilities,
  attendeeId: number,
  referenceIndex: string,
  current: RefundCapability,
): RefundCapability => {
  const original = inherited.get(attendeeId)?.get(referenceIndex);
  return original === undefined ? current : original;
};

type JudgedPaymentRow = {
  decision: ClaimDecision;
  row: PaymentClaimRow;
};

type PaymentClaimRow = PaymentRowRecord & { readonly referenceIndex: string };

const asPaymentClaimRow = async (
  stored: StoredPaymentClaimRow,
): Promise<PaymentClaimRow> => ({
  ...(await asPaymentRowRecord(stored)),
  referenceIndex: stored.payment_reference_index,
});

const inheritedCapabilities = (
  judged: readonly JudgedPaymentRow[],
): InheritedRefundCapabilities =>
  new Map(
    [
      ...Map.groupBy(
        judged.flatMap(({ decision, row }) =>
          decision.kind === "resume" &&
          decision.resuming.capability !== "unresolved"
            ? [
                {
                  attendeeId: row.attendeeId,
                  capability: decision.resuming.capability,
                  index: row.referenceIndex,
                },
              ]
            : [],
        ),
        ({ attendeeId }) => attendeeId,
      ),
    ].map(([attendeeId, references]) => [
      attendeeId,
      new Map(
        references.map(({ capability, index }) => [index, capability] as const),
      ),
    ]),
  );

const representationOf = (
  row: StoredPaymentClaimRow,
): PaymentReferenceRepresentation => ({
  attendeeId: Number(row.attendee_id),
  index: row.payment_reference_index,
  sessionId: row.payment_session_id,
});

const sharedRepresentations = (
  attendees: readonly LoadedRefundAttendee[],
  rows: readonly StoredPaymentClaimRow[],
): ReadonlyMap<string, readonly PaymentReferenceRepresentation[]> =>
  new Map(
    [
      ...new Map(
        attendees.flatMap(({ references }) =>
          references.map((reference) => [reference.index, reference] as const),
        ),
      ).values(),
    ].flatMap((reference) => {
      const matching = rows
        .filter((row) =>
          reference.matchingIndexes.includes(row.payment_reference_index),
        )
        .map(representationOf);
      return matching.length > 1 ? [[reference.index, matching] as const] : [];
    }),
  );

/** Claim every row in the loaded snapshot, or none. Legacy anchors, attendee
 *  revision checks, row-set checks, and holds share one write transaction. */
export const claimAttendeeRows = async (
  attendees: readonly LoadedRefundAttendee[],
  capability: RefundCapability,
): Promise<ClaimResult> => {
  const [claimOwner] = attendees;
  if (claimOwner === undefined) {
    return {
      held: new Map(),
      heldSince: nowIso(),
      inherited: new Map(),
      kind: "claimed",
      returned: new Set(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
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
    const stored = await readClaimableRows(
      tx,
      attendeeIds,
      matchingIndexesOf(attendees),
    );
    if (!rowsMatch(expected, stored.own)) return { kind: "changed" };
    const storedRows = [...stored.own, ...stored.sharing];
    const rows = await Promise.all(storedRows.map(asPaymentClaimRow));
    const ownSessions = new Set(
      stored.own.map((row) => row.payment_session_id),
    );
    // Write transactions serialize, so a rival committed before this read or
    // cannot begin until this run commits.
    const judged = rows.map((row) => ({
      decision: decideClaim(
        row.state.claim,
        {
          attendeeId: ownSessions.has(row.sessionId)
            ? row.attendeeId
            : claimOwner.attendeeId,
          scope: "attendee_set",
        },
        staleBefore,
      ),
      row,
    }));
    const refused = judged.find(({ decision }) => !holdsTheRow(decision));
    if (refused !== undefined) {
      return { blockedBy: refused.decision, kind: "blocked" };
    }
    const inherited = inheritedCapabilities(judged);
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
                row.referenceIndex,
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
        storedRows
          .filter((row) => row.provider_refunded_at !== "")
          .map((row) => row.payment_reference_index),
      ),
      reviews: new Map(
        rows.flatMap((row) =>
          row.state.review === undefined
            ? []
            : [[row.sessionId, row.state.review] as const],
        ),
      ),
      shared: sharedRepresentations(attendees, storedRows),
      unrecorded: new Map(
        [
          ...Map.groupBy(
            rows.filter((row) => row.state.unrecorded !== undefined),
            (row) => row.attendeeId,
          ),
        ].map(([attendeeId, behind]) => [
          attendeeId,
          behind.map((row) => row.sessionId),
        ]),
      ),
    };
  });
};
