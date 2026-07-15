/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeWithoutCacheInvalidation,
  queryOnePrimary,
  resultRows,
} from "#shared/db/client.ts";
import { syncWrittenSetting } from "#shared/db/settings/raw-writes.ts";
import {
  type StringSettingKey,
  setSnapshotField,
} from "#shared/db/settings/snapshot.ts";

/* jscpd:ignore-end */

const StoredJsonSchema = v.object({ value: v.string() });
const JSON_WRITE_ATTEMPTS = 8;

/** Atomically change one boolean inside a stored JSON object. The complete
 * `initialValue` is used when the setting is absent; an existing object changes
 * only at `path`. `whenSql` is an internal SQL condition; no row means the
 * condition blocked the change. */
export const writeBooleanJsonField = async (
  key: StringSettingKey,
  initialValue: string,
  path: string,
  value: boolean,
  whenSql: string,
): Promise<string | null> => {
  const result = await executeWithoutCacheInvalidation(
    `INSERT INTO settings (key, value)
       SELECT ?, ?
       WHERE ${whenSql}
       ON CONFLICT(key) DO UPDATE SET
          value = json_set(settings.value, ?, json(?))
       WHERE ${whenSql}
       RETURNING value`,
    [key, initialValue, path, value ? "true" : "false"],
  );
  const [returned] = resultRows<unknown>(result);
  if (returned === undefined) return null;
  const row = v.parse(StoredJsonSchema, returned);
  const stored = row.value;
  await syncWrittenSetting(key, stored);
  setSnapshotField(key, stored);
  return stored;
};

/** Remove one field from an encrypted JSON setting without replacing changes
 * another request saved to the same object. Returning `null` means the field is
 * already absent. */
export const removeEncryptedJsonField = async (
  key: StringSettingKey,
  remove: (plaintext: string) => string | null,
): Promise<boolean> => {
  for (let attempt = 0; attempt < JSON_WRITE_ATTEMPTS; attempt += 1) {
    const result = await queryOnePrimary<unknown>(
      "SELECT value FROM settings WHERE key = ?",
      [key],
    );
    if (result === null) return false;
    const current = v.parse(StoredJsonSchema, result).value;
    const next = remove(await decrypt(current as EnvKeyEncrypted));
    if (next === null) return false;
    const stored = await encrypt(next);
    const update = await executeWithoutCacheInvalidation(
      "UPDATE settings SET value = ? WHERE key = ? AND value = ?",
      [stored, key, current],
    );
    if (update.rowsAffected === 0) continue;
    await syncWrittenSetting(key, stored);
    setSnapshotField(key, next);
    return true;
  }
  throw new Error(`Setting ${key} changed too often to update`);
};
