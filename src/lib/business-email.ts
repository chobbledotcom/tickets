import { lazyRef } from "#fp";
import { getDb } from "#lib/db/client.ts";
import { CONFIG_KEYS } from "#lib/db/settings.ts";

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
 */
export async function getBusinessEmailFromDb(): Promise<string | null> {
  const cached = getBusinessEmailCache();
  if (cached !== null) return cached;

  const db = getDb();
  const result = await db.execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [CONFIG_KEYS.business_email],
  });

  const value = result.rows.length > 0 ? (result.rows[0].value as string) : null;
  setBusinessEmailCache(value);
  return value;
}

// Lazy reference for permanent caching
const [getBusinessEmailCache, setBusinessEmailCache] = lazyRef<string | null>(() => null);

/**
 * Gets the cached business email (synchronous).
 * Safe to call from templates.
 */
export function getBusinessEmailCached(): string | null {
  return getBusinessEmailCache();
}

/**
 * Updates the business email in the database and invalidates the cache.
 * Pass empty string to clear the business email.
 */
export async function updateBusinessEmail(email: string): Promise<void> {
  const db = getDb();

  // Empty string = clear the setting
  if (email.trim() === "") {
    await db.execute({
      sql: "DELETE FROM settings WHERE key = ?",
      args: [CONFIG_KEYS.business_email],
    });
    setBusinessEmailCache(null);
    return;
  }

  const normalized = normalizeBusinessEmail(email);

  if (!isValidBusinessEmail(normalized)) {
    throw new Error("Invalid business email format");
  }

  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [CONFIG_KEYS.business_email, normalized],
  });

  // Invalidate cache
  setBusinessEmailCache(null);
}
