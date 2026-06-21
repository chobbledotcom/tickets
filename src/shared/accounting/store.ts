/**
 * Persistence adapter for the transfer ledger — the boundary between the pure
 * `src/shared/ledger` library and the `transfers` table.
 *
 * Reads return `Transfer[]` for the pure projections (`balanceOf`, `statementFor`,
 * …) to consume; writes are idempotent by `reference` and **verify** that a
 * replayed reference carries the same financial facts, rather than silently
 * keeping a divergent row (`ON CONFLICT DO NOTHING` would hide a mapper/pricing
 * bug). The clock lives here, not in the library: `recorded_at` is stamped at
 * write time while `occurred_at` (business time) comes from the caller.
 *
 * Not yet wired into the checkout/webhook paths — the event mappers that call
 * this land in the next Phase-1 increment.
 */

import type { InValue } from "@libsql/client";
import {
  executeBatch,
  inPlaceholders,
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

/** Raised when a reused `reference` carries different financial facts than the
 *  transfer already stored under it — a replay after a mapper/pricing change, or
 *  a reference-collision bug. Never silently swallowed. */
export class LedgerConflictError extends Error {
  constructor(reference: string, detail: string) {
    super(`ledger conflict on reference "${reference}": ${detail}`);
    this.name = "LedgerConflictError";
  }
}

/** Outcome of {@link postTransfers}: how many rows were newly written vs. how
 *  many were idempotent replays of an already-stored, matching reference. */
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
): { sql: string; args: ReturnType<typeof insert>["args"] } =>
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

/** Field-by-field financial comparison of a stored transfer to a replayed input.
 *  `memo` is excluded (owner-key ciphertext is non-deterministic) along with the
 *  write-time `recorded_at`/`posted_by` metadata — only money-defining columns. */
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
    ["eventGroup", prior.eventGroup === input.eventGroup],
    ["kind", kindOf(prior) === kindOf(input)],
    ["reversesId", reversesIdOf(prior) === reversesIdOf(input)],
  ];
  return checks.filter(([, matches]) => !matches).map(([field]) => field);
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

const transfersByReferences = (references: string[]): Promise<Transfer[]> =>
  references.length === 0
    ? Promise.resolve([])
    : queryTransfers(
        ` WHERE reference IN (${inPlaceholders(references)})`,
        references,
      );

/**
 * Post a set of transfers, idempotent by `reference`. A reference already stored
 * with the same financial facts is a no-op (counted in `skipped`); one stored
 * with *different* facts throws {@link LedgerConflictError}. All conflict checks
 * run before any write, so a mismatch never leaves a torn partial event behind.
 */
export const postTransfers = async (
  inputs: TransferInput[],
): Promise<PostResult> => {
  for (const input of inputs) {
    const result = validateTransfer(input);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code).join(", ");
      throw new Error(`invalid transfer (${input.reference}): ${codes}`);
    }
  }
  const stored = await transfersByReferences(inputs.map((t) => t.reference));
  const byReference = new Map(stored.map((t) => [t.reference, t]));
  const toInsert: TransferInput[] = [];
  for (const input of inputs) {
    const prior = byReference.get(input.reference);
    if (!prior) {
      toInsert.push(input);
      continue;
    }
    const mismatches = financialMismatches(prior, input);
    if (mismatches.length > 0) {
      throw new LedgerConflictError(
        input.reference,
        `stored transfer differs in ${mismatches.join(", ")}`,
      );
    }
  }
  if (toInsert.length > 0) {
    const recordedAt = nowIso();
    await executeBatch(toInsert.map((t) => insertStatement(t, recordedAt)));
  }
  return {
    inserted: toInsert.length,
    skipped: inputs.length - toInsert.length,
  };
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
