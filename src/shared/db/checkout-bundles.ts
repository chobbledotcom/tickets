/**
 * The whole order of a Stripe or Square checkout, sealed before the buyer
 * leaves. The provider's metadata holds one token, and nothing else the order
 * needs, so the order can be any size and carry any answer.
 *
 * The row rests under the HMAC of the token, and a fresh data key is wrapped
 * with the token itself. A database dump, even with `DB_ENCRYPTION_KEY`, holds
 * no token, so it opens no row. The payments clock prunes rows, which keeps
 * each one past every provider retry and replay.
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
import { nowIso } from "#shared/now.ts";
import { stringRecordJson } from "#shared/validation/stored-json.ts";

/** What opening a token found. A row that is gone and a row that will not open
 * are told apart, because an admin reads them differently. */
export type BundleRead =
  | { status: "opened"; record: Record<string, string> }
  | { status: "missing" }
  | { status: "unreadable" };

/** Seal an order and give back the token that opens it. The token is the only
 * way back in, so the caller must hand it to the provider and keep no copy. */
export const sealCheckoutBundle = async (
  record: Record<string, string>,
): Promise<string> => {
  const token = generateSecureToken();
  const dataKey = await generateDataKey();
  const [tokenIndex, wrappedKey, sealed] = await Promise.all([
    hmacHash(token),
    wrapKeyWithToken(dataKey, token),
    encryptWithKey(stringRecordJson.write(record, "checkout bundle"), dataKey),
  ]);
  await execute(
    insertInto(tables.checkout_bundles, {
      createdAt: nowIso(),
      sealed,
      tokenIndex,
      wrappedKey,
    }),
  );
  return token;
};

/** Name the checkout that a sealed order belongs to, after the provider
 * makes it. A Square checkout can take payment for the link's whole lifetime,
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
