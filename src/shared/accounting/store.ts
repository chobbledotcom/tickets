/**
 * Persistence adapter for the transfer ledger — the boundary between the pure
 * `src/shared/ledger` library and the `transfers` table.
 *
 * Reads return `Transfer[]` for the pure projections (`balanceOf`, `statementFor`,
 * …). Writes are **idempotent per business event**: the legs of one event share
 * an `eventGroup`, and {@link postTransfers} posts that whole set once. A replay
 * of an already-posted event must present the *same* leg set — a changed,
 * added, or removed leg throws {@link LedgerConflictError} rather than silently
 * appending to or diverging from a processed charge. Inserts are conflict-
 * tolerant (`ON CONFLICT(reference) DO NOTHING`), so two handlers racing the same
 * event both succeed: references are deterministic, so the loser's rows are
 * identical and its inserts simply no-op.
 *
 * The clock lives here (`recorded_at`); business time (`occurred_at`) comes from
 * the caller. `memo` is opaque (owner-key ciphertext is non-deterministic, so it
 * is excluded from the replay-equality check).
 */

import type { InValue, ResultSet } from "@libsql/client";
import { sumOf } from "#fp";
import {
  executeBatchWithResults,
  insert,
  queryAll,
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
): { sql: string; args: InValue[] } => {
  const { sql, args } = insert("transfers", {
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
  return { args, sql: `${sql} ON CONFLICT(reference) DO NOTHING` };
};

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
 * Post the legs of one business event, idempotently. Every leg must share one
 * `eventGroup`. If that event is already (even partly) stored, the whole leg set
 * must match or {@link LedgerConflictError} is thrown; otherwise the legs are
 * written in one conflict-tolerant batch.
 */
export const postTransfers = async (
  inputs: TransferInput[],
): Promise<PostResult> => {
  if (inputs.length === 0) return { inserted: 0, skipped: 0 };
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
  const eventGroup = inputs[0]!.eventGroup;
  const existing = await transfersByEventGroup(eventGroup);
  if (existing.length > 0) {
    assertEventMatches(eventGroup, existing, inputs);
    return { inserted: 0, skipped: inputs.length };
  }
  const recordedAt = nowIso();
  const results = await executeBatchWithResults(
    inputs.map((t) => insertStatement(t, recordedAt)),
  );
  // A concurrent writer of the same event makes some inserts no-op (identical
  // rows, by deterministic reference); those count as skipped, not failures.
  const inserted = sumOf((r: ResultSet) => Number(r.rowsAffected))(results);
  return { inserted, skipped: inputs.length - inserted };
};

const queryTransfers = async (
  where: string,
  args: InValue[],
): Promise<Transfer[]> => {
  const rows = await queryAll<TransferRow>(
    `SELECT ${COLUMNS} FROM transfers${where}`,
    args,
  );
  return rows.map(rowToTransfer);
};

/** Every transfer touching `account`, as source or destination. */
export const transfersByAccount = (acct: AccountRef): Promise<Transfer[]> =>
  queryTransfers(
    " WHERE (source_type = ? AND source_id = ?)" +
      " OR (dest_type = ? AND dest_id = ?)",
    [acct.type, acct.id, acct.type, acct.id],
  );

/** Every leg of one business event (booking/refund/…). */
export const transfersByEventGroup = (
  eventGroup: string,
): Promise<Transfer[]> =>
  queryTransfers(" WHERE event_group = ?", [eventGroup]);

/** The whole ledger. For tests and small-ledger reports; scoped reads are
 *  preferred on hot paths. */
export const allTransfers = (): Promise<Transfer[]> => queryTransfers("", []);
