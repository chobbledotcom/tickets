/** Owner-run rebuild of payment rows written before blind indexes existed.
 *
 * Old releases stored an encrypted provider payment reference with no blind
 * index beside it and no provider tag inside it, so the refund authority
 * refuses those attendees. This rebuild gives each row the identity a modern
 * write would: the owner's key opens the reference, the provider the owner
 * states *for that row* tags it, and both are written back.
 *
 * A site can change provider, so one page can span several and the row never
 * says which - the owner states one per row, and an unstated row fails the run.
 * It contacts no payment provider and moves no money. */

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { provenancePointerStatement } from "#db/attendees/payment-provenance.ts";
import { decryptPiiBlob } from "#db/attendees/pii.ts";
import {
  executeBatchWithResults,
  inPlaceholders,
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
import { requiredMapValue } from "#fp";
import {
  type PaymentReference,
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
  processed_at: string;
};

/** The oldest still-legacy rows - the page one run would rewrite. */
const loadLegacyPaymentReferencePage = (): Promise<
  LegacyPaymentReferenceRow[]
> =>
  queryAllPrimary<LegacyPaymentReferenceRow>({
    args: [REBUILD_PAGE_SIZE],
    sql: `SELECT attendee_id, payment_reference, payment_reference_index,
                 payment_session_id, processed_at
              FROM processed_payments
             WHERE ${LEGACY_ROW_PREDICATE}
             ORDER BY processed_at, payment_session_id
             LIMIT ?`,
  });

/** The provider each row takes: the one it already names, or the one the
 * owner stated for that row. An untagged row with no stated provider fails the
 * run - one page's answer never becomes another row's answer. */
const tagFor = (
  row: LegacyPaymentReferenceRow,
  payment: PaymentReference,
  providers: StatedPaymentProviders,
): TaggedPaymentReference => {
  if (payment.kind === "tagged") {
    return payment;
  }
  const stated = providers.get(row.payment_session_id);
  if (stated === undefined) {
    throw new Error(
      `Rebuild has no stated provider for payment session ${row.payment_session_id}`,
    );
  }
  return taggedPaymentReference(stated, payment.reference);
};

/** The stored identity one legacy row needs: its tagged reference, encrypted
 * for the owner key, beside its blind index. */
const rebuiltReferenceStorage = async (
  row: LegacyPaymentReferenceRow,
  providers: StatedPaymentProviders,
  privateKey: CryptoKey,
): Promise<{ payment: PaymentReference; stored: StoredPaymentReference }> => {
  const payment = await loadRowPaymentReference(row, privateKey);
  return {
    payment,
    stored: await storePaymentReference(tagFor(row, payment, providers)),
  };
};

/** The payment id inside each attendee's PII blob, keyed by attendee id, or
 * "" where the blob carries none. This is the id the refund path compares a
 * reference set against, so it is the only payment a provenance pointer may
 * name. One read for the page: a per-row query would spend the run's whole
 * subrequest allowance. */
const attendeePiiPaymentIds = async (
  rows: readonly LegacyPaymentReferenceRow[],
  privateKey: CryptoKey,
): Promise<ReadonlyMap<number, string>> => {
  const attendeeIds = [...new Set(rows.map((row) => row.attendee_id))];
  if (attendeeIds.length === 0) {
    return new Map();
  }
  const blobs = await queryAllPrimary<{
    id: number;
    pii_blob: OwnerKeyEncrypted | "";
  }>({
    args: attendeeIds,
    sql: `SELECT id, pii_blob
            FROM attendees
           WHERE id IN (${inPlaceholders(attendeeIds)})`,
  });
  return new Map(
    await Promise.all(
      blobs.map(
        async (row): Promise<[number, string]> => [
          row.id,
          row.pii_blob === ""
            ? ""
            : (await decryptPiiBlob(row.pii_blob, privateKey, true)).payment_id,
        ],
      ),
    ),
  );
};

/** The rows the next run would rewrite, read for the owner to state a
 * provider against. The page is the one the run takes, so a provider is never
 * chosen for a row the run will not touch. */
export const legacyPaymentReferencePage = async (
  privateKey: CryptoKey,
): Promise<LegacyPaymentReferencePreview[]> => {
  const rows = await loadLegacyPaymentReferencePage();
  return Promise.all(
    rows.map(async (row) => {
      const payment = await loadRowPaymentReference(row, privateKey);
      return {
        alreadyTagged: payment.kind === "tagged",
        paymentSessionId: row.payment_session_id,
        processedAt: row.processed_at,
        reference: payment.reference,
      };
    }),
  );
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

/** The provider the owner states for each row, keyed by payment session id.
 * A row that already names its provider needs no entry. */
export type StatedPaymentProviders = ReadonlyMap<string, PaymentProviderType>;

/** One row of the page a run would rewrite. */
export type LegacyPaymentReferencePreview = {
  /** The row's reference already names its provider, so none is needed. */
  readonly alreadyTagged: boolean;
  readonly paymentSessionId: string;
  readonly processedAt: string;
  /** The provider's own id for the charge, in the clear. */
  readonly reference: string;
};

export type RebuiltLegacyReferences = {
  /** Rows whose reference write landed in this run. */
  readonly rebuilt: number;
  /** Legacy rows still waiting, counted after this run's writes. */
  readonly remaining: number;
  /** Rows tagged whose attendee's PII names a different payment, so their
   * attendee stays unqualified and still cannot be refunded here. */
  readonly unqualified: number;
};

/** Rebuild one bounded page of legacy payment rows, oldest first. Returns the
 * rebuilt count, how many rows still wait, and how many tagged rows left their
 * attendee unqualified; an empty page reports all three as zero. The page
 * commits as one batch: a row that cannot be decrypted, or that has no stated
 * provider, fails the whole run loudly, leaving every row as it was. */
export const rebuildLegacyPaymentReferences = async (
  providers: StatedPaymentProviders,
  privateKey: CryptoKey,
): Promise<RebuiltLegacyReferences> => {
  const rows = await loadLegacyPaymentReferencePage();
  const piiPaymentIds = await attendeePiiPaymentIds(rows, privateKey);
  const referenceWrites: SqlStatement[] = [];
  const provenanceWrites: SqlStatement[] = [];
  let unqualified = 0;
  for (const row of rows) {
    const { payment, stored } = await rebuiltReferenceStorage(
      row,
      providers,
      privateKey,
    );
    referenceWrites.push(referenceWrite(row.payment_session_id, stored));
    const piiPaymentId = requiredMapValue(
      piiPaymentIds,
      row.attendee_id,
      `Rebuild read no PII payment id for attendee ${row.attendee_id}`,
    );
    if (payment.reference !== piiPaymentId) {
      unqualified += 1;
      continue;
    }
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
  return { rebuilt, remaining, unqualified };
};
