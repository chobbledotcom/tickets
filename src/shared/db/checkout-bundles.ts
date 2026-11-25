/**
 * The whole order of a Stripe or Square checkout, sealed before the buyer
 * leaves. The provider's metadata holds one token, and nothing else the order
 * needs, so the order can be any size and carry any answer.
 *
 * The row rests under the HMAC of the token, and a fresh data key is wrapped
 * with the token itself. A database dump, even with `DB_ENCRYPTION_KEY`, holds
 * no token, so it opens no row. A settled session keeps only a receipt with
 * no personal details. The prune deletes a row when its checkout window and
 * the provider retry window are over.
 */

import { decryptWithKey, encryptWithKey } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import {
  generateDataKey,
  unwrapKeyWithToken,
  wrapKeyWithToken,
} from "#crypto/keys.ts";
import type { KeyEncrypted, WrappedKey } from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { execute, queryOne } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { insertInto, update } from "#db/write.ts";
import {
  CHECKOUT_WINDOW_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  WEBHOOK_RETRY_WINDOW_DAYS,
} from "#shared/limits.ts";
import { DAY_MS, nowIso } from "#shared/now.ts";
import { stringRecordJson } from "#shared/validation/stored-json.ts";

/** How long a sealed order is kept, when the payment rows are kept this long.
 * A buyer can pay until the window closes, and the provider can retry the
 * callback after that. A bundle is never kept longer than a payment row. The
 * row is written when the buyer pays, after the bundle, so the bundle always
 * goes first. A receipt never outlives the row that settled it. */
export const bundleRetentionMs = (paymentsRetentionMs: number): number =>
  Math.min(
    CHECKOUT_WINDOW_MS + WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS,
    paymentsRetentionMs,
  );

export const CHECKOUT_BUNDLE_RETENTION_MS = bundleRetentionMs(
  PRUNE_PAYMENTS_RETENTION_MS,
);

/** What opening a token found. A row that is gone and a row that will not open
 * are told apart, because an admin reads them differently. */
export type BundleRead =
  | { status: "opened"; record: Record<string, string> }
  | { status: "missing" }
  | { status: "unreadable" };

/** A record sealed under a fresh data key that the token wraps, with the
 * index the row rests under. */
const sealUnder = async (token: string, record: Record<string, string>) => {
  const dataKey = await generateDataKey();
  const [tokenIndex, wrappedKey, sealed] = await Promise.all([
    hmacHash(token),
    wrapKeyWithToken(dataKey, token),
    encryptWithKey(stringRecordJson.write(record, "checkout bundle"), dataKey),
  ]);
  return { sealed, tokenIndex, wrappedKey };
};

/** Seal an order and give back the token that opens it. The token is the only
 * way back in, so the caller must hand it to the provider and keep no copy. */
export const sealCheckoutBundle = async (
  record: Record<string, string>,
): Promise<string> => {
  const token = generateSecureToken();
  await execute(
    insertInto(tables.checkout_bundles, {
      createdAt: nowIso(),
      ...(await sealUnder(token, record)),
    }),
  );
  return token;
};

/** Seal a new record under a token that already names a row: the record that
 * a settled session keeps in place of its order. */
export const rewriteCheckoutBundle = async (
  token: string,
  record: Record<string, string>,
): Promise<void> => {
  const { sealed, tokenIndex, wrappedKey } = await sealUnder(token, record);
  await execute(
    update(tables.checkout_bundles, { sealed, wrappedKey }).where({
      tokenIndex,
    }),
  );
};

/** Name the checkout that a sealed order belongs to, after the provider
 * makes it. A Square checkout can take payment until its handle row is gone,
 * so the prune keeps the order that long (see `prune.ts`). */
export const linkCheckoutBundleToSession = async (
  token: string,
  sessionId: string,
): Promise<void> => {
  await execute(
    update(tables.checkout_bundles, {
      sessionIndex: await hmacHash(sessionId),
    }).where({ tokenIndex: await hmacHash(token) }),
  );
};

/** Open the order that a token seals. A row that fails to unwrap, decrypt or
 * parse is damaged or was never ours. It reads as `unreadable`, and the caller
 * raises it. */
export const openCheckoutBundle = async (
  token: string,
): Promise<BundleRead> => {
  const row = await queryOne<{ sealed: KeyEncrypted; wrapped_key: WrappedKey }>(
    sql`SELECT sealed, wrapped_key FROM checkout_bundles WHERE token_index = ${await hmacHash(token)}`,
  );
  if (row === null) return { status: "missing" };
  try {
    const dataKey = await unwrapKeyWithToken(row.wrapped_key, token);
    const json = await decryptWithKey(row.sealed, dataKey);
    return {
      record: stringRecordJson.read(json, "checkout bundle"),
      status: "opened",
    };
  } catch {
    // A row that will not open is the documented `unreadable` answer: the
    // caller reports it and refuses the callback so the provider retries.
    return { status: "unreadable" };
  }
};
