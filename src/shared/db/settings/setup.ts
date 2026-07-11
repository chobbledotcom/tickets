/**
 * Setup-complete permanent cache + the initial site-setup ceremony.
 *
 * `isSetupComplete` is queried on every request that hits a route, so it has a
 * permanent in-memory short-circuit (set once setup flipped to true) on top of
 * the on-demand loader. `completeSetup` is the one-time write that lands the
 * owner account, its wrapped DATA_KEY and keypair, and the `setup_complete`
 * flag in a single batch — no half-initialised site can result.
 */

import { lazyRef } from "#fp";
import { registerCacheReset } from "#shared/cache-registry.ts";
import { encryptWithKey } from "#shared/crypto/encryption.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import {
  generateDataKey,
  generateKeyPair,
  wrapDataKeyForPassword,
} from "#shared/crypto/keys.ts";
import { executeBatch } from "#shared/db/client.ts";
import { bumpSettingsVersion } from "#shared/db/settings/cache.ts";
import { invalidateCache, loadKeys } from "#shared/db/settings/load.ts";
import { getRawCached, settingUpsert } from "#shared/db/settings/raw-writes.ts";
import { buildCreateUserStatement } from "#shared/db/users.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const [getSetupCompleteCache, setSetupCompleteCache] = lazyRef<boolean>(
  () => false,
);
const [getSetupConfirmed, setSetupConfirmed] = lazyRef<boolean>(() => false);

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

/**
 * The initial site-setup ceremony — creates the owner account, generates and
 * stores the DATA_KEY and keypair, sets the country, and flips
 * `setup_complete` on, all in one batch so a mid-write failure rolls back
 * every piece. The owner's wrapped DATA_KEY is v2 (bound to the raw password),
 * so attendee PII can't be unwrapped from a DB dump alone.
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

  // The whole setup ceremony commits in one transaction: the owner account and
  // every config key land together, so a mid-write failure can never leave a
  // half-initialised site (an owner with no keypair, or setup_complete set
  // before the owner row exists). All values are computed above, so this is a
  // plain batch — no inter-statement logic — rather than an interactive
  // transaction.
  const ownerInsert = await buildCreateUserStatement(
    username,
    hashedPassword,
    wrappedDataKey,
    "owner",
  );
  await executeBatch([
    ownerInsert,
    settingUpsert(CONFIG_KEYS.WRAPPED_PRIVATE_KEY, encryptedPrivateKey),
    settingUpsert(CONFIG_KEYS.PUBLIC_KEY, publicKey),
    settingUpsert(CONFIG_KEYS.COUNTRY, country),
    settingUpsert(CONFIG_KEYS.SETUP_COMPLETE, "true"),
  ]);
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
