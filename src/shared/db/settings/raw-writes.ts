/**
 * Raw DB write/read helpers for the settings table.
 *
 * Each writer persists the value, mirrors it into the in-memory raw cache (so
 * the rest of this request reads its own write), and bumps the shared
 * `settings_version` so other isolates reload on their next request.
 *
 * `stringUpdate` lifts the writer into a `(key) => (v) => Promise` factory so
 * the same code path backs both the encrypted and plaintext generated-string
 * accessors (and the wallet settings factories, which take an
 * `EncryptedUpdateFn`).
 */

import { encrypt } from "#shared/crypto/encryption.ts";
import {
  executeBatchWithoutCacheInvalidation,
  executeWithoutCacheInvalidation,
  type SqlStatement,
} from "#shared/db/client.ts";
import {
  bumpSettingsVersion,
  getRawCached,
  settingsVersionIncrement,
  syncCache,
} from "#shared/db/settings/cache.ts";
import {
  type StringSettingKey,
  setSnapshotField,
} from "#shared/db/settings/snapshot.ts";
import { recordSettingsLoaded } from "#shared/db/settings-audit.ts";
import type { EncryptedUpdateFn } from "#shared/wallets/wallet-settings-types.ts";

export { getRawCached };

/** Upsert a single settings key/value (latest write wins). */
const SETTINGS_UPSERT_SQL =
  "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)";

/** Build a settings upsert as a batch statement (used by `completeSetup`). */
export const settingUpsert = (key: string, value: string): SqlStatement => ({
  args: [key, value],
  sql: SETTINGS_UPSERT_SQL,
});

/**
 * After changing one settings row: record it as loaded (a write makes the key's
 * value — or its absence, after a delete — known this request, so reading it
 * back is safe and it counts as available for the read audit), apply `mutate`
 * to the raw cache values, mark the key loaded, and bump the shared version so
 * other isolates reload on their next request.
 */
const afterSettingChange = async (
  key: string,
  mutate: (values: Map<string, string>) => void,
): Promise<void> => {
  recordSettingsLoaded([key]);
  syncCache((s) => {
    mutate(s.values);
    s.loaded.add(key);
  });
  await bumpSettingsVersion();
};

/** Write a setting to the DB, update the raw cache in-place, and bump the
 *  shared version so other isolates reload on their next request. */
export const writeRaw = async (key: string, value: string): Promise<void> => {
  await executeWithoutCacheInvalidation(SETTINGS_UPSERT_SQL, [key, value]);
  await afterSettingChange(key, (values) => values.set(key, value));
};

/** Persist several related settings in one transaction and one version bump. */
export const writeRawBatch = async (
  values: ReadonlyArray<readonly [key: string, value: string]>,
): Promise<void> => {
  if (values.length === 0)
    throw new Error("Cannot write an empty settings batch");
  await executeBatchWithoutCacheInvalidation([
    ...values.map(([key, value]) => settingUpsert(key, value)),
    settingsVersionIncrement(),
  ]);
  recordSettingsLoaded(values.map(([key]) => key));
  syncCache((state) => {
    for (const [key, value] of values) {
      state.values.set(key, value);
      state.loaded.add(key);
    }
  });
};

/** Delete a setting from the DB, drop it from the raw cache, and bump the
 *  shared version so other isolates reload on their next request. */
export const deleteRaw = async (key: string): Promise<void> => {
  await executeWithoutCacheInvalidation("DELETE FROM settings WHERE key = ?", [
    key,
  ]);
  await afterSettingChange(key, (values) => values.delete(key));
};

/** A (key, value) writer for the settings table. */
type SettingWriter = (key: string, value: string) => Promise<void>;

/**
 * Build a writer that upserts the value via {@link writeRaw}, deleting the row
 * when the value is empty. `encode` transforms the stored value first so both
 * the plaintext (`writeOrDelete`) and encrypted (`writeEncrypted`) writers
 * share the same "empty means delete" branch + version bump + cache sync.
 */
const makeWriter =
  (
    encode: (value: string) => Promise<string> = async (v) => v,
  ): SettingWriter =>
  async (key, value) => {
    if (value === "") return deleteRaw(key);
    await writeRaw(key, await encode(value));
  };

/** Write a setting or delete it if value is empty (plaintext path). */
export const writeOrDelete: SettingWriter = makeWriter();

/** Encrypt then write (empty string deletes the key). */
export const writeEncrypted: SettingWriter = makeWriter(encrypt);

/**
 * Factory: run `writer` then mirror the value into the snapshot. Accepts any
 * string key so it satisfies `EncryptedUpdateFn` for wallet factories; callers
 * always pass a `CONFIG_KEYS.*` value that is a real snapshot field.
 */
const stringUpdate =
  (writer: (key: string, value: string) => Promise<void>) =>
  (key: string) =>
  async (v: string): Promise<void> => {
    await writer(key, v);
    setSnapshotField(key as StringSettingKey, v);
  };

/** Encrypt then write, mirroring the plaintext into the snapshot. */
export const encryptedUpdate: EncryptedUpdateFn = stringUpdate(writeEncrypted);

/** Write (or delete, when empty) a plaintext value, mirroring into snapshot. */
export const plaintextUpdate: EncryptedUpdateFn = stringUpdate(writeOrDelete);
