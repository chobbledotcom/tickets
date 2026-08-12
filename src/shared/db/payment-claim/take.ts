/** Taking an all-or-none hold on the exact refund snapshot an admin loaded. */

/* jscpd:ignore-start -- imports */
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  claimRequestFor,
  nextClaimFor,
} from "#shared/db/payment-claim/scope.ts";
import {
  asPaymentRowRecord,
  type PaymentRowRecord,
  paymentRowStateStatement,
  paymentRowsWith,
  readPaymentClaimRows,
  type StoredPaymentClaimRow,
} from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
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
  RefundClaim,
  RefundClaimPhase,
  RefundProviderCapability,
} from "#shared/payment/row-state.ts";
/* jscpd:ignore-end */

/** What happened when a run asked for an attendee's rows. */
export type ClaimResult =
  | { blockedBy: ClaimDecision; kind: "blocked" }
  | { kind: "changed" }
  | { kind: "not_admitted" }
  | {
    /** Each attendee's claimed rows, kept apart so a run can let one
     *  attendee go while another's answer is still in doubt. */
    held: ReadonlyMap<number, readonly string[]>;
    commandId: string;
    heldSince: string;
    kind: "claimed";
    /** References inheriting a crashed run's doubt, under that reference's
     *  own provider capability and grouped for attendee-wide settlement. */
    inherited: InheritedArmedRefunds;
    /** The exact phase each row must still hold when this run settles it. */
    phases: ReadonlyMap<string, RefundClaimPhase>;
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
 *  `loadedPiiBlob` is the attendee revision, so a concurrent save cannot
 *  change the indexed payment set beneath the claim. */
export type LoadedRefundAttendee = {
  readonly attendeeId: number;
  /** The loaded rows already carried a claim mirror. */
  readonly held?: boolean;
  readonly loadedPiiBlob: string;
  readonly references: readonly RefundPaymentReference[];
};

/** Exact row-backed facts a pure pre-claim gate may recheck under the lock. */
export type RefundClaimAdmissionFacts = {
  readonly attendees: readonly LoadedRefundAttendee[];
  /** Holds inherited from the authoritative rows read inside this claim. */
  readonly inherited: InheritedArmedRefunds;
  readonly returned: ReadonlySet<string>;
};

export type RefundClaimAdmission = (
  facts: RefundClaimAdmissionFacts,
) => boolean;

/** One exact durable row that represents a provider charge. */
export type PaymentReferenceRepresentation = {
  readonly attendeeId: number;
  readonly index: string;
  readonly sessionId: string;
};

/** Provider retry facts inherited by each attendee and exact reference. */
export type InheritedArmedRefunds = ReadonlyMap<
  number,
  ReadonlyMap<string, RefundProviderCapability>
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
    `attendee_id IN (${inPlaceholders(attendeeIds)})
       AND payment_reference != ''
       AND payment_reference_index != ''`,
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
    references.flatMap(({ matchingIndexes }) => matchingIndexes)
  );

/** Row identities the loaded snapshot says the run must hold. */
const expectedRowsBySession = (
  attendees: readonly LoadedRefundAttendee[],
): ReadonlyMap<string, ExpectedPaymentRow> =>
  new Map(
    attendees.flatMap((attendee) =>
      attendee.references.flatMap((reference) =>
        reference.rowSessionIds.map(
          (sessionId) =>
            [
              sessionId,
              {
                attendeeId: attendee.attendeeId,
                referenceIndex: reference.index,
              },
            ] as const,
        )
      )
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

type JudgedPaymentRow = {
  decision: ClaimDecision;
  nextClaim: RefundClaim;
  row: PaymentClaimRow;
};

type PaymentClaimRow = PaymentRowRecord & { readonly referenceIndex: string };

const asPaymentClaimRow = async (
  stored: StoredPaymentClaimRow,
): Promise<PaymentClaimRow> => ({
  ...(await asPaymentRowRecord(stored)),
  referenceIndex: stored.payment_reference_index,
});

const inheritedArmedRefunds = (
  judged: readonly JudgedPaymentRow[],
): InheritedArmedRefunds =>
  new Map(
    [
      ...Map.groupBy(
        judged.flatMap(({ decision, row }) =>
          decision.kind === "resume" && decision.resuming.phase === "send_armed"
            ? [
              {
                attendeeId: row.attendeeId,
                capability: decision.resuming.capability,
                index: row.referenceIndex,
              },
            ]
            : []
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
          references.map((reference) => [reference.index, reference] as const)
        ),
      ).values(),
    ].flatMap((reference) => {
      const matching = rows
        .filter((row) =>
          reference.matchingIndexes.includes(row.payment_reference_index)
        )
        .map(representationOf);
      return matching.length > 1 ? [[reference.index, matching] as const] : [];
    }),
  );

/** Claim every row in the loaded snapshot, or none. Attendee revision checks,
 * row-set checks, and holds share one write transaction. */
export const claimAttendeeRows = async (
  attendees: readonly LoadedRefundAttendee[],
  admit?: RefundClaimAdmission,
): Promise<ClaimResult> => {
  const commandId = crypto.randomUUID();
  if (attendees.length === 0) {
    if (
      admit !== undefined &&
      !admit({ attendees, inherited: new Map(), returned: new Set() })
    ) {
      return { kind: "not_admitted" };
    }
    return {
      commandId,
      held: new Map(),
      heldSince: nowIso(),
      inherited: new Map(),
      kind: "claimed",
      phases: new Map(),
      returned: new Set(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    };
  }
  const attendeeIds = attendees.map((attendee) => attendee.attendeeId);
  const expected = expectedRowsBySession(attendees);
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
    const stored = await readClaimableRows(
      tx,
      attendeeIds,
      matchingIndexesOf(attendees),
    );
    if (!rowsMatch(expected, stored.own)) return { kind: "changed" };
    const storedRows = [...stored.own, ...stored.sharing];
    const rows = await Promise.all(storedRows.map(asPaymentClaimRow));
    // Write transactions serialize, so a rival committed before this read or
    // cannot begin until this run commits.
    const judged = rows.map((row) => {
      const request = claimRequestFor(attendees, row);
      const decision = decideClaim(row.state.claim, request, staleBefore);
      return {
        decision,
        nextClaim: nextClaimFor(decision, request, commandId, writtenAt),
        row,
      };
    });
    const refused = judged.find(({ decision }) => !holdsTheRow(decision));
    if (refused !== undefined) {
      return { blockedBy: refused.decision, kind: "blocked" };
    }
    const inherited = inheritedArmedRefunds(judged);
    const returned = new Set(
      storedRows
        .filter((row) => row.provider_refunded_at !== "")
        .map((row) => row.payment_reference_index),
    );
    if (admit !== undefined && !admit({ attendees, inherited, returned })) {
      return { kind: "not_admitted" };
    }
    await tx.batch(
      await Promise.all(
        judged.map(({ nextClaim, row }) =>
          paymentRowStateStatement(row, { ...row.state, claim: nextClaim })
        ),
      ),
    );
    return {
      commandId,
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
      phases: new Map(
        judged.map(({ nextClaim, row }) => [row.sessionId, nextClaim.phase]),
      ),
      returned,
      reviews: new Map(
        paymentRowsWith(rows, ({ review }) => review).map(({ row, value }) => [
          row.sessionId,
          value.reason,
        ]),
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
