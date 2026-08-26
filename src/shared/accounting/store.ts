/**
 * Write path for the transfers ledger. Posting is idempotent per business
 * event: the legs of one event share an `eventGroup`, and {@link postTransfers}
 * writes that whole set once. If the same event is posted again it must present
 * the exact same legs (checked in {@link file://./conflicts.ts}) rather than
 * quietly append to a charge that was already handled.
 *
 * The post runs in one write transaction and reads the already-stored legs
 * through that same transaction. So if two requests post the same event at once,
 * the database write lock makes them take turns: one does the real post, the
 * other sees those rows and replays as a no-op. No half-written event is left
 * behind, so the insert needs no conflict clause.
 *
 * The clock lives here (`recorded_at`), and the business time (`occurred_at`)
 * comes from the caller.
 */

import type { InValue } from "@libsql/client";
import {
  eventMatchConflict,
  LedgerConflictError,
  reversalConflict,
} from "#accounting/conflicts.ts";
import {
  insertStatement,
  selectTransfersMany,
  type TransferRead,
} from "#accounting/rows.ts";
import {
  type BatchExecutor,
  executeBatch,
  orIgnore,
  queryBatch,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { inList } from "#db/where-clauses.ts";
import { identity, mapById, mapNotNullish, unique } from "#fp";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { assertValidTransfer } from "#shared/ledger/validate.ts";
import { nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";

/** Outcome of {@link postTransfers}: rows newly written vs idempotent replays. */
export type PostResult = {
  readonly inserted: number;
  readonly skipped: number;
};

/** One independently postable set of event groups. */
export type PostTransferBatchResult =
  | { readonly kind: "posted"; readonly results: PostResult[] }
  | { readonly error: LedgerConflictError; readonly kind: "conflict" };

/** A {@link PostResult} for a no-op post — nothing inserted, nothing skipped. */
const EMPTY_RESULT: PostResult = { inserted: 0, skipped: 0 };

/** Every leg's reference across a set of event groups, flattened in order. */
const allReferences = (groups: TransferInput[][]): string[] =>
  groups.flatMap((inputs) => inputs.map((t) => t.reference));

const eventGroupOf = (inputs: TransferInput[]): string =>
  requireValue(inputs[0], "Ledger event cannot be empty").eventGroup;

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
    assertValidTransfer(input, `invalid transfer (${input.reference})`);
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
 * accompanies. Same idempotency rules as {@link postTransfers}: if the event is
 * already stored the whole leg set must match, otherwise the legs are inserted.
 * An empty post is a no-op.
 *
 * The conflict checks are {@link planGroup}'s — the single implementation both
 * write paths share — against a snapshot read THROUGH this transaction, so the
 * database write lock makes concurrent posters of the same event take turns.
 * Because that in-transaction read is authoritative, the inserts stay plain (no
 * `OR IGNORE`), which keeps constraint violations loud: a double void that
 * slipped past the checks still fails on the unique `reverses_id` index.
 */
export const postTransfersTx = async (
  tx: TxScope,
  inputs: TransferInput[],
): Promise<PostResult> => {
  if (inputs.length === 0) return EMPTY_RESULT;
  assertPostable(inputs);
  const snapshot = await loadBatchSnapshot([inputs], tx.batch);
  const planned = planGroup(inputs, snapshot, nowIso());
  if (planned.kind === "conflict") throw planned.error;
  const { inserts, result } = planned;
  for (const statement of inserts) await tx.execute(statement);
  return result;
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
): Promise<PostResult> =>
  requireValue(
    (await postTransferGroups([inputs]))[0],
    "Ledger post omitted its event",
  );

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

/** Wants every transfer whose `column` is one of `values`; an empty set asks for
 *  nothing, and is answered without touching the database. `column` is a
 *  trusted constant. */
const byColumnIn = (
  column: string,
  values: readonly InValue[],
): TransferRead => ({
  where: inList(column, values),
});

/** Load everything {@link planGroup} needs to validate the batch, in three bulk
 *  selects that travel as one round trip — independent of the number of groups.
 *  `read` picks where the snapshot comes from: the global client for the batch
 *  path, or an open transaction for {@link postTransfersTx} (whose write lock
 *  makes the read authoritative). */
const loadBatchSnapshot = async (
  groups: TransferInput[][],
  read: BatchExecutor,
): Promise<BatchSnapshot> => {
  const eventGroups = unique(groups.map(eventGroupOf));
  const references = allReferences(groups);
  const reversesIds = unique(
    mapNotNullish((t: TransferInput) => t.reversesId)(groups.flat()),
  );
  const [existing, stored, originals] = await selectTransfersMany(read, [
    byColumnIn("event_group", eventGroups),
    byColumnIn("reference", references),
    byColumnIn("id", reversesIds),
  ]);
  return {
    existingByGroup: Map.groupBy(existing, (leg) => leg.eventGroup),
    originalsById: mapById(identity<Transfer>)(originals),
    storedByReference: new Map(stored.map((leg) => [leg.reference, leg])),
  };
};

/**
 * Plan one event group against the snapshot: the INSERT statements to run (empty
 * for an idempotent replay of an already-stored event) and the would-be
 * {@link PostResult}. Pure — every conflict is detected *here*, before any write,
 * so the batch's transaction body is a plain list of inserts that commits without
 * interleaved reads. A real conflict is a named result: a changed leg on an
 * already-stored event, a reference owned by another event, or a bad reversal
 * link. Unexpected failures still escape instead of being misclassified.
 */
type PlannedGroup =
  | {
      readonly inserts: SqlStatement[];
      readonly kind: "posted";
      readonly result: PostResult;
    }
  | { readonly error: LedgerConflictError; readonly kind: "conflict" };

const replayPlan = (
  eventGroup: string,
  existing: Transfer[],
  inputs: TransferInput[],
): PlannedGroup | null => {
  if (existing.length === 0) return null;
  const error = eventMatchConflict(eventGroup, existing, inputs);
  return error === null
    ? {
        inserts: [],
        kind: "posted",
        result: { inserted: 0, skipped: inputs.length },
      }
    : { error, kind: "conflict" };
};

const newLegConflict = (
  input: TransferInput,
  eventGroup: string,
  snapshot: BatchSnapshot,
): LedgerConflictError | null => {
  const collision = snapshot.storedByReference.get(input.reference);
  if (collision && collision.eventGroup !== eventGroup) {
    return new LedgerConflictError(
      input.reference,
      "reference already belongs to a different event",
    );
  }
  const id = input.reversesId;
  return reversalConflict(
    input,
    id === undefined || id === null
      ? null
      : (snapshot.originalsById.get(id) ?? null),
  );
};

const planGroup = (
  inputs: TransferInput[],
  snapshot: BatchSnapshot,
  recordedAt: string,
  render: (statement: SqlStatement) => SqlStatement = (statement) => statement,
): PlannedGroup => {
  const eventGroup = eventGroupOf(inputs);
  const existing = snapshot.existingByGroup.get(eventGroup) ?? [];
  const replay = replayPlan(eventGroup, existing, inputs);
  if (replay !== null) return replay;
  const error = inputs
    .map((input) => newLegConflict(input, eventGroup, snapshot))
    .find((conflict) => conflict !== null);
  if (error !== undefined) return { error, kind: "conflict" };
  return {
    inserts: inputs.map((input) => render(insertStatement(input, recordedAt))),
    kind: "posted",
    result: { inserted: inputs.length, skipped: 0 },
  };
};

/**
 * Post the legs of MANY business events as ONE atomic batch: the reusable
 * primitive for an operation that produces several independent events at once,
 * such as a bulk refund or an import. Each element of `groups` is one event's
 * legs (sharing one `eventGroup`), validated and inserted with the same rules as
 * {@link postTransfersTx}, but all committed together.
 *
 * A write transaction per event contends the single SQLite writer, and a
 * read-then-write inside one long interactive transaction lets open result sets
 * block the commit at scale. So a read-only prepare validates every group
 * against a bulk-loaded {@link BatchSnapshot}, then a write-only apply commits.
 *
 * Idempotent per event, ordered to match `groups`, and all-or-nothing. Conflict
 * detection is the snapshot's, so a *later* repost of a changed event is caught
 * while a concurrent race on the same references is absorbed by INSERT OR IGNORE.
 */
const assertUniqueGroups = (groups: TransferInput[][]): void => {
  const nonEmpty = groups.filter((inputs) => inputs.length > 0);
  for (const inputs of nonEmpty) assertPostable(inputs);
  const eventGroups = nonEmpty.map(eventGroupOf);
  if (new Set(eventGroups).size !== eventGroups.length) {
    throw new Error(
      "postTransferGroups: duplicate eventGroup across the batch",
    );
  }
  const allRefs = allReferences(nonEmpty);
  if (new Set(allRefs).size !== allRefs.length) {
    throw new Error("postTransferGroups: duplicate reference across the batch");
  }
};

type PlannedTransferBatch =
  | {
      readonly inserts: SqlStatement[];
      readonly kind: "posted";
      readonly results: PostResult[];
    }
  | { readonly error: LedgerConflictError; readonly kind: "conflict" };

const planTransferBatch = (
  groups: TransferInput[][],
  snapshot: BatchSnapshot,
  recordedAt: string,
): PlannedTransferBatch => {
  const inserts: SqlStatement[] = [];
  const results: PostResult[] = [];
  for (const inputs of groups) {
    if (inputs.length === 0) {
      results.push(EMPTY_RESULT);
      continue;
    }
    const planned = planGroup(inputs, snapshot, recordedAt, orIgnore);
    if (planned.kind === "conflict") return planned;
    inserts.push(...planned.inserts);
    results.push(planned.result);
  }
  return { inserts, kind: "posted", results };
};

/** One outcome for each set posted, in the order the sets were given, so a
 *  caller passing a known number of sets can name them by destructuring. */
type ResultPerBatch<Batches extends readonly TransferInput[][][]> = {
  [Index in keyof Batches]: PostTransferBatchResult;
};

/** The outcome for a set with no legs in it. Annotated rather than written
 *  inline, so the shape is still checked despite the tuple cast at the return. */
const nothingToPost = (
  batch: readonly TransferInput[][],
): PostTransferBatchResult => ({
  kind: "posted",
  results: batch.map(() => EMPTY_RESULT),
});

/**
 * Post several independent sets of event groups from one ledger snapshot and
 * one write. A stored-data conflict rejects only its own set; malformed input
 * and database failures still reject the whole call.
 */
export const postTransferGroupBatches = async <
  const Batches extends readonly TransferInput[][][],
>(
  batches: Batches,
): Promise<ResultPerBatch<Batches>> => {
  const groups = batches.flat();
  const nonEmpty = groups.filter((inputs) => inputs.length > 0);
  if (nonEmpty.length === 0) {
    // Mapped from the sets given, so it is one outcome per set by construction.
    return batches.map(nothingToPost) as ResultPerBatch<Batches>;
  }
  assertUniqueGroups(groups);
  const snapshot = await loadBatchSnapshot(nonEmpty, queryBatch);
  const recordedAt = nowIso();
  const planned = batches.map((batch) =>
    planTransferBatch(batch, snapshot, recordedAt),
  );
  const inserts = planned.flatMap((batch) =>
    batch.kind === "posted" ? batch.inserts : [],
  );
  if (inserts.length > 0) await executeBatch(inserts);
  // Mapped from the sets given, so it is one outcome per set by construction.
  return planned.map((batch) =>
    batch.kind === "conflict"
      ? batch
      : { kind: batch.kind, results: batch.results },
  ) as ResultPerBatch<Batches>;
};

export const postTransferGroups = async (
  groups: TransferInput[][],
): Promise<PostResult[]> => {
  const [result] = await postTransferGroupBatches([groups]);
  if (result.kind === "conflict") throw result.error;
  return result.results;
};
