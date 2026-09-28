/** Owner-run rebuild of payment rows written before blind indexes existed.
 *
 * Old releases stored an attendee's encrypted provider payment reference with
 * no blind index beside it and no provider tag inside it, so the refund
 * authority refuses those attendees. This rebuild gives each row the same
 * stored identity a modern write would: it decrypts the reference with the
 * owner's private key, tags it with the operator-stated provider, and writes
 * the encrypted value and its index back. It qualifies the attendee provenance
 * pointer with the same rule a booking finalize uses. It contacts no payment
 * provider and moves no money.
 */

import { provenancePointerStatement } from "#db/attendees/payment-provenance.ts";
import {
  executeBatchWithResults,
  queryAllPrimary,
  queryOnePrimary,
  type SqlStatement,
} from "#db/client.ts";
import {
  type IndexedPaymentReferenceSource,
  loadRowPaymentReference,
  type StoredPaymentReference,
  storePaymentReference,
} from "#db/payment-reference-store.ts";
import {
  type TaggedPaymentReference,
  taggedPaymentReference,
} from "#payment/provider-reference.ts";
import { requireValue } from "#shared/required-value.ts";
import type { PaymentProviderType } from "#types";

/** How many rows one rebuild run rewrites. The owner presses the button again
 * until nothing remains, so a large site stays inside one request budget. */
const REBUILD_PAGE_SIZE = 50;

/** The rows a rebuild may touch: attendee-bearing rows that still hold a
 * payment reference with no blind index beside it. A rebuilt row leaves this
 * predicate, so every run naturally takes the next unrepaired page. */
const LEGACY_ROW_PREDICATE = `
       payment_reference != ''
       AND payment_reference_index = ''
       AND attendee_id IS NOT NULL`;

export const countLegacyPaymentReferences = async (): Promise<number> => {
  const row = requireValue(
    await queryOnePrimary<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM processed_payments
        WHERE ${LEGACY_ROW_PREDICATE}`,
      [],
    ),
    "Legacy payment reference count returned no row",
  );
  return Number(row.total);
};

/** A still-legacy row: the indexed-source shape with its attendee linkage,
 * its index still blank. */
type LegacyPaymentReferenceRow = IndexedPaymentReferenceSource & {
  attendee_id: number;
};

/** The oldest still-legacy rows. */
const loadLegacyPaymentReferencePage = (): Promise<
  LegacyPaymentReferenceRow[]
> =>
  queryAllPrimary<LegacyPaymentReferenceRow>({
    args: [REBUILD_PAGE_SIZE],
    sql: `SELECT attendee_id, payment_reference, payment_reference_index,
                 payment_session_id
              FROM processed_payments
             WHERE ${LEGACY_ROW_PREDICATE}
             ORDER BY processed_at, payment_session_id
             LIMIT ?`,
  });

/** The stored identity one legacy row needs: its tagged reference, encrypted
 * for the owner key, beside its blind index. */
const rebuiltReferenceStorage = async (
  row: LegacyPaymentReferenceRow,
  provider: PaymentProviderType,
  privateKey: CryptoKey,
): Promise<StoredPaymentReference> => {
  const payment = await loadRowPaymentReference(row, privateKey);
  // A reference that already names its provider keeps that name; the operator
  // states a provider only for the rows written before tags existed.
  const tagged: TaggedPaymentReference =
    payment.kind === "tagged"
      ? payment
      : taggedPaymentReference(provider, payment.reference);
  return storePaymentReference(tagged);
};

/** Give one row the modern reference write: the encrypted tag beside its
 * index, guarded so a replayed or concurrent rebuild cannot overwrite a row
 * another path has already indexed. */
const referenceWrite = (
  sessionId: string,
  stored: StoredPaymentReference,
): SqlStatement => ({
  args: [stored.encrypted, stored.index, sessionId],
  sql: `UPDATE processed_payments
           SET payment_reference = ?, payment_reference_index = ?
         WHERE payment_session_id = ?
           AND payment_reference_index = ''`,
});

export type RebuiltLegacyReferences = {
  /** Rows whose reference write landed in this run. */
  readonly rebuilt: number;
  /** Legacy rows still waiting, counted after this run's writes. */
  readonly remaining: number;
};

/** Rebuild one bounded page of legacy payment rows, oldest first. Returns the
 * rebuilt count and how many rows still wait; an empty page reports both as
 * zero. The page commits as one batch: a row that cannot be decrypted or
 * tagged fails the whole run loudly, leaving every row as it was. */
export const rebuildLegacyPaymentReferences = async (
  provider: PaymentProviderType,
  privateKey: CryptoKey,
): Promise<RebuiltLegacyReferences> => {
  const rows = await loadLegacyPaymentReferencePage();
  const referenceWrites: SqlStatement[] = [];
  const provenanceWrites: SqlStatement[] = [];
  for (const row of rows) {
    const stored = await rebuiltReferenceStorage(row, provider, privateKey);
    referenceWrites.push(referenceWrite(row.payment_session_id, stored));
    provenanceWrites.push(provenancePointerStatement(row.payment_session_id));
  }
  // Every reference write precedes every provenance write, so the provenance
  // subquery of each row sees that row's new index.
  const results =
    referenceWrites.length > 0
      ? await executeBatchWithResults([...referenceWrites, ...provenanceWrites])
      : [];
  const rebuilt = results
    .slice(0, referenceWrites.length)
    .reduce((sum, result) => sum + result.rowsAffected, 0);
  const remaining = await countLegacyPaymentReferences();
  return { rebuilt, remaining };
};
