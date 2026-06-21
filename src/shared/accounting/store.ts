/**
 * Persistence adapter for the transfer ledger — the boundary between the pure
 * `src/shared/ledger` library and the `transfers` table.
 *
 * Reads return `Transfer[]` for the pure projections (`balanceOf`, `statementFor`,
 * …). Writes are **idempotent per business event**: the legs of one event share
 * an `eventGroup`, and {@link postTransfers} posts that whole set once. A replay
 * of an already-posted event must present the *same* leg set — a changed, added,
 * or removed leg throws {@link LedgerConflictError} rather than silently appending
 * to or diverging from a processed charge.
 *
 * The post runs inside one interactive write transaction. libsql's write lock
 * serialises concurrent posters of the same event: the first commits its legs;
 * the second then acquires the lock, reads those committed legs *through its own
 * transaction*, and takes the idempotent replay-match path (asserting the leg set
 * matches, inserting nothing). So a race resolves to one post plus one no-op
 * replay with no partially-written event, and the insert needs no conflict
 * clause.
 *
 * The clock lives here (`recorded_at`); business time (`occurred_at`) comes from
 * the caller. `memo` is opaque (owner-key ciphertext is non-deterministic, so it
 * is excluded from the replay-equality check).
 */

import type { InValue, Transaction } from "@libsql/client";
import {
  inPlaceholders,
  insert,
  queryAll,
  resultRows,
  withTransaction,
} from "#shared/db/client.ts";
import { account, sameAccount } from "#shared/ledger/account.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";
import { nowIso } from "#shared/now.ts";

/** Raised when a replayed event diverges from what is already stored — a leg
 *  with different financial facts, an extra leg, or a missing leg. Surfaced
 *  loudly so a mapper/pricing change can't quietly rewrite a processed charge. */
export class LedgerConflictError extends Error {
  constructor(reference: string, detail: string) {
    super(`ledger conflict on reference "${reference}": ${detail}`);
    this.name = "LedgerConflictError";
  }
}

/** Outcome of {@link postTransfers}: rows newly written vs. idempotent replays. */
export type PostResult = {
  readonly inserted: number;
  readonly skipped: number;
};

type TransferRow = {
  id: number | bigint;
  source_type: string;
  source_id: string;
  dest_type: string;
  dest_id: string;
  amount: number | bigint;
  currency: string;
  occurred_at: string;
  recorded_at: string;
  reference: string;
  event_group: string;
  kind: string;
  memo: string;
  reverses_id: number | bigint | null;
  posted_by: string;
};

const COLUMNS =
  "id, source_type, source_id, dest_type, dest_id, amount, currency, " +
  "occurred_at, recorded_at, reference, event_group, kind, memo, " +
  "reverses_id, posted_by";

const rowToTransfer = (row: TransferRow): Transfer => ({
  amount: Number(row.amount),
  currency: row.currency,
  destination: account(row.dest_type, row.dest_id),
  eventGroup: row.event_group,
  id: Number(row.id),
  kind: row.kind,
  memo: row.memo,
  occurredAt: row.occurred_at,
  postedBy: row.posted_by,
  recordedAt: row.recorded_at,
  reference: row.reference,
  reversesId: row.reverses_id === null ? undefined : Number(row.reverses_id),
  source: account(row.source_type, row.source_id),
});

const insertStatement = (
  t: TransferInput,
  recordedAt: string,
): { sql: string; args: InValue[] } =>
  insert("transfers", {
    amount: t.amount,
    currency: t.currency,
    dest_id: t.destination.id,
    dest_type: t.destination.type,
    event_group: t.eventGroup,
    kind: t.kind ?? "",
    memo: t.memo ?? "",
    occurred_at: t.occurredAt,
    posted_by: t.postedBy ?? "system",
    recorded_at: recordedAt,
    reference: t.reference,
    reverses_id: t.reversesId ?? null,
    source_id: t.source.id,
    source_type: t.source.type,
  });

/** Money-defining fields only: `memo` (non-deterministic ciphertext) and the
 *  write-time `recorded_at`/`posted_by` metadata are excluded. */
const kindOf = (t: { kind?: string }): string => t.kind ?? "";
const reversesIdOf = (t: { reversesId?: number }): number | null =>
  t.reversesId ?? null;

const financialMismatches = (
  prior: Transfer,
  input: TransferInput,
): string[] => {
  const checks: [field: string, matches: boolean][] = [
    ["amount", prior.amount === input.amount],
    ["currency", prior.currency === input.currency],
    ["source", sameAccount(prior.source, input.source)],
    ["destination", sameAccount(prior.destination, input.destination)],
    ["occurredAt", prior.occurredAt === input.occurredAt],
    ["kind", kindOf(prior) === kindOf(input)],
    ["reversesId", reversesIdOf(prior) === reversesIdOf(input)],
  ];
  return checks.filter(([, matches]) => !matches).map(([field]) => field);
};

/**
 * Assert that a replayed event presents exactly the stored leg set. Throws on a
 * stored leg the replay omits, a replay leg never stored, or a financial change.
 */
const assertEventMatches = (
  eventGroup: string,
  stored: Transfer[],
  inputs: TransferInput[],
): void => {
  const storedByRef = new Map(stored.map((t) => [t.reference, t]));
  const inputRefs = new Set(inputs.map((t) => t.reference));
  for (const leg of stored) {
    if (!inputRefs.has(leg.reference)) {
      throw new LedgerConflictError(
        leg.reference,
        `event "${eventGroup}" is already posted with a leg this replay omits`,
      );
    }
  }
  for (const input of inputs) {
    const prior = storedByRef.get(input.reference);
    if (!prior) {
      throw new LedgerConflictError(
        input.reference,
        `event "${eventGroup}" is already posted without this leg`,
      );
    }
    const mismatches = financialMismatches(prior, input);
    if (mismatches.length > 0) {
      throw new LedgerConflictError(
        input.reference,
        `stored leg differs in ${mismatches.join(", ")}`,
      );
    }
  }
};

/**
 * Pure pre-flight checks, run before any DB work so a malformed batch never
 * opens a transaction: every leg is valid on its own, and the batch as a whole
 * shares one event group and one currency (a mixed-currency event passes
 * per-leg validation but would later make every balance projection throw) with
 * no duplicate reference (which would silently under-post).
 */
const assertPostable = (inputs: TransferInput[]): void => {
  for (const input of inputs) {
    const result = validateTransfer(input);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code).join(", ");
      throw new Error(`invalid transfer (${input.reference}): ${codes}`);
    }
  }
  const eventGroups = new Set(inputs.map((t) => t.eventGroup));
  if (eventGroups.size > 1) {
    throw new Error(
      `postTransfers: every leg must share one eventGroup (got ${eventGroups.size})`,
    );
  }
  const currencies = new Set(inputs.map((t) => t.currency));
  if (currencies.size > 1) {
    throw new Error(
      `postTransfers: every leg must share one currency (got ${[
        ...currencies,
      ].join(", ")})`,
    );
  }
  const references = inputs.map((t) => t.reference);
  if (new Set(references).size !== references.length) {
    throw new Error("postTransfers: duplicate reference within one event");
  }
};

/** A minimal row reader — either the global client or an open transaction. The
 *  fresh-post path reads through its own transaction so libsql's write lock
 *  serialises concurrent posters into the idempotent replay path. */
type RowReader = (sql: string, args: InValue[]) => Promise<TransferRow[]>;

const fromDb: RowReader = (sql, args) => queryAll<TransferRow>(sql, args);

const fromTx =
  (tx: Transaction): RowReader =>
  async (sql, args) =>
    resultRows<TransferRow>(await tx.execute({ args, sql }));

const selectTransfers = async (
  read: RowReader,
  where: string,
  args: InValue[],
): Promise<Transfer[]> => {
  const rows = await read(`SELECT ${COLUMNS} FROM transfers${where}`, args);
  return rows.map(rowToTransfer);
};

const selectByEventGroup = (
  read: RowReader,
  eventGroup: string,
): Promise<Transfer[]> =>
  selectTransfers(read, " WHERE event_group = ?", [eventGroup]);

/** The stored transfers among the given references (used to detect a reference
 *  colliding with a different event before a fresh insert). */
const selectByReferences = (
  read: RowReader,
  references: string[],
): Promise<Transfer[]> =>
  selectTransfers(
    read,
    ` WHERE reference IN (${inPlaceholders(references)})`,
    references,
  );

/**
 * Post the legs of one business event, idempotently. Every leg must share one
 * `eventGroup` and one `currency` and carry a distinct `reference`. Runs in one
 * interactive write transaction: if the event is already stored, the whole leg
 * set must match or {@link LedgerConflictError} is thrown (and nothing is
 * written); otherwise — if no reference already belongs to a different event —
 * the legs are inserted and committed together.
 */
export const postTransfers = async (
  inputs: TransferInput[],
): Promise<PostResult> => {
  if (inputs.length === 0) return { inserted: 0, skipped: 0 };
  assertPostable(inputs);
  const eventGroup = inputs[0]!.eventGroup;
  const references = inputs.map((t) => t.reference);
  return withTransaction(async (tx) => {
    const read = fromTx(tx);
    const existing = await selectByEventGroup(read, eventGroup);
    if (existing.length > 0) {
      assertEventMatches(eventGroup, existing, inputs);
      return { inserted: 0, skipped: inputs.length };
    }
    // No legs for this event yet, so any already-stored reference belongs to a
    // *different* event — reject before inserting (the transaction would roll
    // back anyway, but this gives the precise conflicting reference).
    const colliding = await selectByReferences(read, references);
    if (colliding.length > 0) {
      throw new LedgerConflictError(
        colliding[0]!.reference,
        "reference already belongs to a different event",
      );
    }
    const recordedAt = nowIso();
    for (const input of inputs) {
      await tx.execute(insertStatement(input, recordedAt));
    }
    return { inserted: inputs.length, skipped: 0 };
  });
};

/** Every transfer touching `account`, as source or destination. */
export const transfersByAccount = (acct: AccountRef): Promise<Transfer[]> =>
  selectTransfers(
    fromDb,
    " WHERE (source_type = ? AND source_id = ?)" +
      " OR (dest_type = ? AND dest_id = ?)",
    [acct.type, acct.id, acct.type, acct.id],
  );

/** Every leg of one business event (booking/refund/…). */
export const transfersByEventGroup = (
  eventGroup: string,
): Promise<Transfer[]> => selectByEventGroup(fromDb, eventGroup);

/** The whole ledger. For tests and small-ledger reports; scoped reads are
 *  preferred on hot paths. */
export const allTransfers = (): Promise<Transfer[]> =>
  selectTransfers(fromDb, "", []);
