/**
 * Setup-complete permanent cache + the initial site-setup ceremony.
 *
 * `isSetupComplete` is queried on every request that hits a route, so it has a
 * permanent in-memory short-circuit (set once setup flipped to true) on top of
 * the on-demand loader. `completeSetup` is the one-time write that lands the
 * owner account, its wrapped DATA_KEY and keypair, and the `setup_complete`
 * flag in one guarded transaction — no half-initialised site can result.
 */

import { encryptWithKey } from "#crypto/encryption.ts";
import { hashPassword } from "#crypto/hashing.ts";
import {
  generateDataKey,
  generateKeyPair,
  wrapDataKeyForPassword,
} from "#crypto/keys.ts";
import { type SqlStatement, withTransaction } from "#db/client.ts";
import { bumpSettingsVersion } from "#db/settings/cache.ts";
import { invalidateCache, loadKeys } from "#db/settings/load.ts";
import { getRawCached, settingUpsert } from "#db/settings/raw-writes.ts";
import { buildCreateUserStatement } from "#db/users.ts";
import { lazyRef } from "#fp";
import { registerCacheReset } from "#shared/cache-registry.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const [getSetupCompleteCache, setSetupCompleteCache] = lazyRef<boolean>(
  () => false,
);
const [getSetupConfirmed, setSetupConfirmed] = lazyRef<boolean>(() => false);
const SETUP_CLAIM_VALUE = "claiming";
const SETUP_DONE_VALUE = "true";

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Setup is already complete");
    this.name = "SetupAlreadyCompleteError";
  }
}

export const isSetupComplete = async (): Promise<boolean> => {
  const confirmed = getSetupConfirmed();
  const cached = getSetupCompleteCache();
  if (confirmed && cached) return true;
  // Fetch only the one key we read; loadKeys serves it from the cache when the
  // version is unchanged, so this is near-free on a warm isolate.
  await loadKeys([CONFIG_KEYS.SETUP_COMPLETE]);
  const isComplete = getRawCached(CONFIG_KEYS.SETUP_COMPLETE) === "true";
  if (isComplete) {
    setSetupCompleteCache(true);
    setSetupConfirmed(true);
  }
  return isComplete;
};

export const clearSetupCompleteCache = (): void => {
  setSetupCompleteCache(null);
  setSetupConfirmed(null);
};

// The permanent short-circuit survives no full reset/restore: no table
// registration covers it (it never re-reads once true), so hook the sweep.
registerCacheReset(clearSetupCompleteCache);

const claimSetupSlot = (): SqlStatement => ({
  args: [CONFIG_KEYS.SETUP_COMPLETE, SETUP_CLAIM_VALUE, SETUP_DONE_VALUE],
  sql:
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
    "WHERE settings.value <> ?",
});

/**
 * The initial site-setup ceremony — creates the owner account, generates and
 * stores the DATA_KEY and keypair, sets the country, and flips
 * `setup_complete` on in one transaction. The settings primary key is the
 * cross-isolate setup slot: once any request claims and commits it as done,
 * every later request fails before it can create another owner or keypair.
 */
export const completeSetup = async (
  username: string,
  adminPassword: string,
  country: string,
): Promise<void> => {
  const hashedPassword = await hashPassword(adminPassword);
  const dataKey = await generateDataKey();
  const { publicKey, privateKey } = await generateKeyPair();
  // Bind the owner's wrapped DATA_KEY to the raw password (v2), so the DATA_KEY
  // — and therefore all attendee PII — can't be unwrapped from a DB dump alone.
  const wrappedDataKey = await wrapDataKeyForPassword(
    dataKey,
    adminPassword,
    hashedPassword,
  );
  const encryptedPrivateKey = await encryptWithKey(privateKey, dataKey);

  const ownerInsert = await buildCreateUserStatement(
    username,
    hashedPassword,
    wrappedDataKey,
    "owner",
  );
  await withTransaction(async (tx) => {
    const claim = await tx.execute(claimSetupSlot());
    if (claim.rowsAffected !== 1) throw new SetupAlreadyCompleteError();
    await tx.batch([
      ownerInsert,
      settingUpsert(CONFIG_KEYS.WRAPPED_PRIVATE_KEY, encryptedPrivateKey),
      settingUpsert(CONFIG_KEYS.PUBLIC_KEY, publicKey),
      settingUpsert(CONFIG_KEYS.COUNTRY, country),
      settingUpsert(CONFIG_KEYS.SETUP_COMPLETE, SETUP_DONE_VALUE),
    ]);
  });
  // Setup's config lands via a batch (not writeRaw), so bump the version by hand
  // to keep the cross-isolate signal consistent.
  await bumpSettingsVersion();

  // Setup flips the global routing gate. Drop any partially-loaded settings
  // snapshot from pre-setup requests so the next request cannot keep serving
  // stale defaults (notably a cached missing setup_complete row). Mark the
  // permanent setup gate as confirmed so the immediate /setup/complete redirect
  // succeeds without another DB round-trip.
  invalidateCache();
  setSetupCompleteCache(true);
  setSetupConfirmed(true);
};
