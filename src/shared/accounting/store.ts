/**
 * Write path for the transfers ledger.
 *
 * Posting is idempotent per business event: the legs of one event share an
 * `eventGroup`, and {@link postTransfers} writes that whole set once. If the same
 * event is posted again it must present the exact same legs (checked in
 * {@link file://./conflicts.ts}) rather than quietly appending to a charge that
 * was already handled.
 *
 * The post runs in one write transaction and reads the already-stored legs
 * through that same transaction. So if two requests post the same event at once,
 * the database write lock makes them take turns: one does the real post, the
 * other sees those rows and replays as a no-op. No half-written event is left
 * behind, so the insert needs no conflict clause.
 *
 * The clock lives here (`recorded_at`); the business time (`occurred_at`) comes
 * from the caller.
 */

import type { InValue } from "@libsql/client";
import { groupBy } from "#fp";
import {
  assertEventMatches,
  assertReverses,
  assertReversesAgainst,
  LedgerConflictError,
} from "#shared/accounting/conflicts.ts";
import {
  fromDb,
  fromTx,
  insertStatement,
  orIgnore,
  selectByEventGroup,
  selectByReferences,
  selectTransfers,
} from "#shared/accounting/rows.ts";
import {
  executeBatch,
  inPlaceholders,
  type TxScope,
} from "#shared/db/client.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";
import { nowIso } from "#shared/now.ts";

/** A built INSERT statement ready for the batch writer. */
type Statement = { sql: string; args: InValue[] };

/** Outcome of {@link postTransfers}: rows newly written vs idempotent replays. */
export type PostResult = {
  readonly inserted: number;
  readonly skipped: number;
};

/** A {@link PostResult} for a no-op post — nothing inserted, nothing skipped. */
const EMPTY_RESULT: PostResult = { inserted: 0, skipped: 0 };

/** Every leg of one event must agree on `label`; name the offending values if not. */
const assertShared = (label: string, values: string[]): void => {
  const distinct = new Set(values);
  if (distinct.size > 1) {
    throw new Error(
      `postTransfers: every leg must share one ${label} (got ${[
        ...distinct,
      ].join(", ")})`,
    );
  }
};

/**
 * Checks that need no database, run before any DB work so a malformed batch never
 * opens a transaction: every leg is valid on its own, the batch shares one event
 * group, and no reference is repeated (which would silently under-post). Currency
 * needs no check — a site has one, fixed at setup, so every leg shares it.
 */
export const assertPostable = (inputs: TransferInput[]): void => {
  for (const input of inputs) {
    const result = validateTransfer(input);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code).join(", ");
      throw new Error(`invalid transfer (${input.reference}): ${codes}`);
    }
  }
  assertShared(
    "eventGroup",
    inputs.map((t) => t.eventGroup),
  );
  const references = inputs.map((t) => t.reference);
  if (new Set(references).size !== references.length) {
    throw new Error("postTransfers: duplicate reference within one event");
  }
};

/**
 * Post the legs of one business event inside an already-open transaction, so the
 * ledger write commits or rolls back together with the domain rows it
 * accompanies (a booking and its sale/payment legs land together or not at all).
 * Same idempotency rules as {@link postTransfers}: if the event is already
 * stored the whole leg set must match, otherwise the legs are inserted. An empty
 * post is a no-op.
 */
export const postTransfersTx = async (
  tx: TxScope,
  inputs: TransferInput[],
): Promise<PostResult> => {
  if (inputs.length === 0) return EMPTY_RESULT;
  assertPostable(inputs);
  const eventGroup = inputs[0]!.eventGroup;
  const references = inputs.map((t) => t.reference);
  const read = fromTx(tx);
  const existing = await selectByEventGroup(read, eventGroup);
  if (existing.length > 0) {
    assertEventMatches(eventGroup, existing, inputs);
    return { inserted: 0, skipped: inputs.length };
  }
  // No legs for this event yet, so any already-stored reference belongs to a
  // different event — reject before inserting (naming the exact reference).
  const colliding = await selectByReferences(read, references);
  if (colliding.length > 0) {
    throw new LedgerConflictError(
      colliding[0]!.reference,
      "reference already belongs to a different event",
    );
  }
  const recordedAt = nowIso();
  for (const input of inputs) {
    // Check the void link against the stored original before inserting, so a bad
    // reversal never uses up the unique reverses_id slot.
    await assertReverses(read, input);
    await tx.execute(insertStatement(input, recordedAt));
  }
  return { inserted: inputs.length, skipped: 0 };
};

/**
 * Post the legs of one business event idempotently. Every leg must share one
 * `eventGroup` and carry a distinct `reference`. Delegates to the single-group
 * case of {@link postTransferGroups} so the conflict checks read the ledger
 * *before* the write opens and the legs land in one batch round-trip — never an
 * interactive transaction holding the write lock open across a read-per-leg (the
 * "Transaction timed-out" shape for a many-leg refund). Use {@link postTransfersTx}
 * to post within a wider transaction (e.g. together with a booking).
 */
export const postTransfers = async (
  inputs: TransferInput[],
): Promise<PostResult> => (await postTransferGroups([inputs]))[0]!;

/**
 * The slice of the ledger a whole batch validates itself against, read up front
 * in a fixed handful of bulk queries (never one-per-group), so posting many
 * events stays well under the N+1 read guard and — crucially — does all its
 * reads *before* the write opens. Holds: the legs already stored for the batch's
 * event groups (idempotent-replay / changed-leg check), every stored leg sharing
 * one of the batch's references (cross-event collision check), and the originals
 * any reversing leg points at.
 */
type BatchSnapshot = {
  readonly existingByGroup: ReadonlyMap<string, Transfer[]>;
  readonly storedByReference: ReadonlyMap<string, Transfer>;
  readonly originalsById: ReadonlyMap<number, Transfer>;
};

/** Read every transfer whose `column` is one of `values`; [] for an empty set
 *  without touching the database. `column` is a trusted constant, never input. */
const selectByColumnIn = (
  column: string,
  values: readonly InValue[],
): Promise<Transfer[]> =>
  values.length === 0
    ? Promise.resolve([])
    : selectTransfers(
        fromDb,
        ` WHERE ${column} IN (${inPlaceholders(values)})`,
        [...values],
      );

/** Load everything {@link planGroup} needs to validate the batch, in three bulk
 *  selects — independent of the number of groups. */
const loadBatchSnapshot = async (
  groups: TransferInput[][],
): Promise<BatchSnapshot> => {
  const eventGroups = [
    ...new Set(groups.map((inputs) => inputs[0]!.eventGroup)),
  ];
  const references = groups.flatMap((inputs) => inputs.map((t) => t.reference));
  const reversesIds = [
    ...new Set(
      groups.flatMap((inputs) =>
        inputs
          .map((t) => t.reversesId)
          .filter((id): id is number => id !== undefined && id !== null),
      ),
    ),
  ];
  const [existing, stored, originals] = await Promise.all([
    selectByColumnIn("event_group", eventGroups),
    selectByColumnIn("reference", references),
    selectByColumnIn("id", reversesIds),
  ]);
  return {
    existingByGroup: groupBy(existing, (leg) => leg.eventGroup),
    originalsById: new Map(originals.map((leg) => [leg.id, leg])),
    storedByReference: new Map(stored.map((leg) => [leg.reference, leg])),
  };
};

/**
 * Plan one event group against the snapshot: the INSERT statements to run (empty
 * for an idempotent replay of an already-stored event) and the would-be
 * {@link PostResult}. Pure — every conflict is detected *here*, before any write,
 * so the batch's transaction body is a plain list of inserts that commits without
 * interleaved reads. Throws {@link LedgerConflictError} on a real conflict: a
 * changed leg on an already-stored event, a reference owned by another event, or
 * a bad reversal link.
 */
const planGroup = (
  inputs: TransferInput[],
  snapshot: BatchSnapshot,
  recordedAt: string,
): { inserts: Statement[]; result: PostResult } => {
  const eventGroup = inputs[0]!.eventGroup;
  const existing = snapshot.existingByGroup.get(eventGroup) ?? [];
  if (existing.length > 0) {
    // Already posted: the whole leg set must still match (a mapper/pricing change
    // can't quietly rewrite a stored charge), then this group writes nothing.
    assertEventMatches(eventGroup, existing, inputs);
    return { inserts: [], result: { inserted: 0, skipped: inputs.length } };
  }
  const inserts: Statement[] = [];
  for (const input of inputs) {
    // A stored leg holding our reference but belonging to a different event owns
    // that reference already — reject before inserting (naming the reference).
    const collision = snapshot.storedByReference.get(input.reference);
    if (collision && collision.eventGroup !== eventGroup) {
      throw new LedgerConflictError(
        input.reference,
        "reference already belongs to a different event",
      );
    }
    const id = input.reversesId;
    assertReversesAgainst(
      input,
      id === undefined || id === null
        ? null
        : (snapshot.originalsById.get(id) ?? null),
    );
    // INSERT OR IGNORE so a leg a concurrent poster committed between the snapshot
    // read and this write is skipped rather than violating the unique reference
    // (the same idempotent-insert approach the backfill uses); references are
    // deterministic, so an ignored row is byte-identical to the one already there.
    inserts.push(orIgnore(insertStatement(input, recordedAt)));
  }
  return { inserts, result: { inserted: inputs.length, skipped: 0 } };
};

/**
 * Post the legs of MANY business events as ONE atomic batch — the reusable
 * primitive for any operation that produces several independent events at once: a
 * bulk refund, an import, a multi-order adjustment. Each element of `groups` is
 * one event's legs (sharing one `eventGroup`), validated and inserted with the
 * same rules as {@link postTransfersTx}, but all committed together.
 *
 * Unlike opening a write transaction per event (which contends the single SQLite
 * writer — SQLITE_BUSY — once enough overlap) or reading-then-writing inside one
 * long interactive transaction (whose open result sets block the commit at
 * scale — "SQL statements in progress"), this splits the work in two: a read-only
 * *prepare* (validate every group against a bulk-loaded {@link BatchSnapshot},
 * building the insert statements) followed by a write-only *apply* (one atomic
 * `batch` of just those inserts). So the reads never sit inside the write and the
 * batch commits cleanly no matter how many events it carries.
 *
 * Idempotent per event and ordered to match `groups` (an empty group → a zero
 * result). All-or-nothing: a conflict throws before any write, and a write error
 * rolls the whole batch back. Conflict detection is the snapshot's: a *later*
 * repost of a changed event is caught, while a sub-millisecond concurrent race on
 * the same deterministic references is absorbed by INSERT OR IGNORE.
 */
export const postTransferGroups = async (
  groups: TransferInput[][],
): Promise<PostResult[]> => {
  const nonEmpty = groups.filter((inputs) => inputs.length > 0);
  if (nonEmpty.length === 0) return groups.map(() => EMPTY_RESULT);
  // No-DB checks for the whole batch first, so a malformed batch never reads or
  // writes: each group valid on its own, and across the batch no repeated
  // reference (which would silently under-post or collide two events).
  for (const inputs of nonEmpty) assertPostable(inputs);
  // Each element of `groups` must be ONE event — distinct event groups. Two
  // elements sharing an eventGroup would both plan against the same pre-write
  // snapshot (neither sees the other), both insert, and the event would end up
  // holding the UNION of their legs — after which an idempotent replay of either
  // original fails `assertEventMatches`. Reject up front (chunks for one event
  // must be combined into a single group before calling this).
  const eventGroups = nonEmpty.map((inputs) => inputs[0]!.eventGroup);
  if (new Set(eventGroups).size !== eventGroups.length) {
    throw new Error(
      "postTransferGroups: duplicate eventGroup across the batch",
    );
  }
  const allRefs = nonEmpty.flatMap((inputs) => inputs.map((t) => t.reference));
  if (new Set(allRefs).size !== allRefs.length) {
    throw new Error("postTransferGroups: duplicate reference across the batch");
  }
  const snapshot = await loadBatchSnapshot(nonEmpty);
  const recordedAt = nowIso();
  const inserts: Statement[] = [];
  const planned = nonEmpty.map((inputs) => {
    const { inserts: groupInserts, result } = planGroup(
      inputs,
      snapshot,
      recordedAt,
    );
    inserts.push(...groupInserts);
    return result;
  });
  if (inserts.length > 0) await executeBatch(inserts);
  // Re-expand to match the caller's groups, slotting EMPTY_RESULT for the empties
  // that were filtered out before planning.
  let next = 0;
  return groups.map((inputs) =>
    inputs.length > 0 ? planned[next++]! : EMPTY_RESULT,
  );
};
