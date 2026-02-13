import { lazyRef } from "#fp";
import { getDb } from "#lib/db/client.ts";
import { CONFIG_KEYS } from "#lib/db/settings.ts";
import { decrypt, encrypt } from "#lib/crypto.ts";

/**
 * Validates a basic email format: something@something.something
 */
export function isValidBusinessEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed) return false;

  // Basic email regex: something@something.something
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed);
}

/**
 * Normalizes email: trim and lowercase
 */
export function normalizeBusinessEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Gets the business email from the database (async, with permanent cache).
 * Returns decrypted email.
 */
export async function getBusinessEmailFromDb(): Promise<string> {
  const cached = getBusinessEmailCache();
  if (cached !== "") return cached;

  const db = getDb();
  const result = await db.execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [CONFIG_KEYS.BUSINESS_EMAIL],
  });

  const row = result.rows[0];
  if (!row?.value) {
    setBusinessEmailCache("");
    return "";
  }

  const decrypted = await decrypt(row.value as string);
  setBusinessEmailCache(decrypted);
  return decrypted;
}

// Lazy reference for permanent caching
const [getBusinessEmailCache, setBusinessEmailCache] = lazyRef<string>(() => "");

/**
 * Gets the cached business email (synchronous).
 * Safe to call from templates.
 */
export function getBusinessEmailCached(): string {
  return getBusinessEmailCache();
}

/**
 * Invalidate the business email cache (for testing or after external updates).
 */
export function invalidateBusinessEmailCache(): void {
  setBusinessEmailCache("");
}

/**
 * Updates the business email in the database and invalidates the cache.
 * Pass empty string to clear the business email.
 * Email is encrypted at rest.
 */
export async function updateBusinessEmail(email: string): Promise<void> {
  const db = getDb();

  // Empty string = clear the setting
  if (email.trim() === "") {
    await db.execute({
      sql: "DELETE FROM settings WHERE key = ?",
      args: [CONFIG_KEYS.BUSINESS_EMAIL],
    });
    setBusinessEmailCache("");
    return;
  }

  const normalized = normalizeBusinessEmail(email);

  if (!isValidBusinessEmail(normalized)) {
    throw new Error("Invalid business email format");
  }

  const encrypted = await encrypt(normalized);
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [CONFIG_KEYS.BUSINESS_EMAIL, encrypted],
  });

  // Update cache with decrypted value
  setBusinessEmailCache(normalized);
}
