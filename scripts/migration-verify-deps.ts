/**
 * Production wiring for the migration-readiness verifier.
 *
 * Builds the database-backed reader and the owner-key provider that
 * `runMigrationVerifyCli` (in `migration-verify-lib.ts`) drives. The reader
 * keyset-paginates the legacy payment tables so a large database never trips
 * libsqld's "Response is too large" cap; the owner-key provider derives the
 * site's private key from an owner-authenticated password and decrypts attendee
 * PII and merge-reference charges in-process. Nothing here writes to the
 * database — every read is read-only migration input.
 */

import type { InValue } from "@libsql/client";
import type {
  MigrationVerifyOwnerKey,
  MigrationVerifyReader,
} from "#scripts/migration-verify-lib.ts";
import {
  decryptWithOwnerKey,
  HYBRID_PREFIX,
  unwrapKey,
} from "#shared/crypto/keys.ts";
import {
  deriveOwnerKek,
  privateKeyFromDataKey,
} from "#shared/crypto/owner-kek.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { queryAll } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  decryptAdminLevel,
  getUserByUsername,
  verifyUserPassword,
} from "#shared/db/users.ts";
import type {
  AttendeePiiSource,
  CheckoutStageRow,
  ProcessedPaymentRow,
  SumupCheckoutRow,
} from "#shared/migration-readiness/readiness.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const DEFAULT_VERIFY_PAGE_SIZE = 500;

/** Read every row of a table as keyset pages, so no single libsql response
 *  exceeds its payload cap. `whereClause` narrows the read (e.g. real-audience
 *  PII); the cursor advances past the previous page's last primary key. */
const keysetRows = async <T>(
  sqlPrefix: string,
  whereClause: string | null,
  pkColumn: string,
  pageSize: number,
): Promise<T[]> => {
  const rows: T[] = [];
  let after: InValue = null;
  for (;;) {
    const conds: string[] = [];
    const args: InValue[] = [];
    if (whereClause) conds.push(whereClause);
    if (after !== null) {
      conds.push(`${pkColumn} > ?`);
      args.push(after);
    }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const page = await queryAll<T>(
      `${sqlPrefix}${where} ORDER BY ${pkColumn} LIMIT ?`,
      [...args, pageSize],
    );
    if (page.length === 0) break;
    rows.push(...page);
    after = (page[page.length - 1] as Record<string, unknown>)[
      pkColumn
    ] as InValue;
    if (page.length < pageSize) break;
  }
  return rows;
};

/** The legacy payment tables the verifier reads, in the order its reports list
 *  them. Each read selects only the columns the readiness rules use. */
export const createMigrationVerifyReader = (
  pageSize: number = DEFAULT_VERIFY_PAGE_SIZE,
): MigrationVerifyReader => ({
  readAttendeeIds: () => {
    // Only real attendees hold payments; servicing rows (vans/crews) are never
    // valid payment targets, so exclude them from the live-attendee set.
    const ids = keysetRows<{ id: number }>(
      "SELECT id FROM attendees",
      `kind = '${ATTENDEE_KIND}'`,
      "id",
      pageSize,
    );
    return ids.then((rows) => new Set(rows.map((row) => row.id)));
  },
  readAttendeePii: () =>
    keysetRows<AttendeePiiSource>(
      "SELECT id, pii_blob FROM attendees",
      "kind = 'attendee' AND pii_blob != ''",
      "id",
      pageSize,
    ),
  readCheckoutStages: () =>
    keysetRows<CheckoutStageRow>(
      "SELECT payment_session_id, attendee_id, provider, state, created_at FROM checkout_stages",
      null,
      "payment_session_id",
      pageSize,
    ),
  readProcessedPayments: () =>
    keysetRows<ProcessedPaymentRow>(
      "SELECT payment_session_id, attendee_id, processed_at, payment_reference, provider_refunded_at, failure_data FROM processed_payments",
      null,
      "payment_session_id",
      pageSize,
    ),
  readSumupCheckouts: () =>
    keysetRows<SumupCheckoutRow>(
      "SELECT reference_index, sumup_id, created_at FROM sumup_checkouts",
      null,
      "reference_index",
      pageSize,
    ),
});

/** Whether an owner-key-encrypted payment reference decrypts under the key. An
 *  empty value is nothing to verify. A non-hybrid value is a legacy plaintext
 *  payment_reference (development builds wrote the column in the clear — see
 *  `payment-references.ts`), so it is treated as decryptable. A hybrid
 *  ciphertext that throws on decrypt is not. Returns no plaintext. */
const paymentReferenceDecrypts = async (
  value: OwnerKeyEncrypted | "",
  key: CryptoKey,
): Promise<boolean> => {
  if (value === "" || !value.startsWith(HYBRID_PREFIX)) return true;
  try {
    await decryptWithOwnerKey(value as OwnerKeyEncrypted, key);
    return true;
  } catch {
    return false;
  }
};

/**
 * The owner-key provider: an owner-authenticated step that derives the site
 * private key from an owner password, then proves it can decrypt (and parse)
 * every attendee PII blob and every payment reference. A wrong password, a
 * non-owner account, a missing wrapped-data key, or an absent wrapped private
 * key returns null — the caller then blocks rather than skipping the encrypted
 * charges. PII plaintext never leaves this step; only ids/keys that failed are
 * returned.
 */
export const createMigrationVerifyOwnerKey = (): MigrationVerifyOwnerKey => ({
  derive: async (username, password) => {
    const user = await getUserByUsername(username);
    if (!user?.wrapped_data_key) return null;
    const passwordHash = await verifyUserPassword(user, password);
    if (!passwordHash) return null;
    // The private key protects attendee PII for the whole site, so only an
    // owner-level account may derive it through this command.
    const adminLevel = await decryptAdminLevel(user);
    if (adminLevel !== "owner") return null;
    await settings.loadKeys([CONFIG_KEYS.WRAPPED_PRIVATE_KEY]);
    if (!settings.wrappedPrivateKey) return null;
    const kek = await deriveOwnerKek(password, passwordHash, user.kek_version);
    const dataKey = await unwrapKey(user.wrapped_data_key, kek);
    return privateKeyFromDataKey(dataKey, settings.wrappedPrivateKey);
  },
  verify: async (key, inputs) => {
    const undecryptablePii = new Set<number>();
    const undecryptablePaymentReferences = new Set<string>();
    for (const { id, pii_blob } of inputs.attendees) {
      if (pii_blob === "") continue;
      try {
        // Decrypt AND parse: a blob that decrypts to malformed JSON or one
        // missing required PII fields would fail the real attendee readers, so
        // it must fail readiness too. Non-hybrid blobs throw here (PII has no
        // legacy plaintext fallback), catching corrupt plaintext PII.
        await decryptPiiBlob(pii_blob as OwnerKeyEncrypted, key, true);
      } catch {
        undecryptablePii.add(id);
      }
    }
    for (const {
      payment_reference,
      payment_session_id,
    } of inputs.paymentReferences) {
      if (!(await paymentReferenceDecrypts(payment_reference, key))) {
        undecryptablePaymentReferences.add(payment_session_id);
      }
    }
    return { undecryptablePaymentReferences, undecryptablePii };
  },
});
