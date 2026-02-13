import { getDb } from "#lib/db/client.ts";
import { CONFIG_KEYS, getSetting, setSetting } from "#lib/db/settings.ts";
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
 * Gets the business email from the database (uses settings cache).
 * Returns decrypted email or empty string if not set.
 */
export async function getBusinessEmailFromDb(): Promise<string> {
  const value = await getSetting(CONFIG_KEYS.BUSINESS_EMAIL);
  if (!value) return "";
  return decrypt(value);
}

/**
 * Updates the business email in the database and invalidates the settings cache.
 * Pass empty string to clear the business email.
 * Email is encrypted at rest.
 */
export async function updateBusinessEmail(email: string): Promise<void> {
  // Empty string = clear the setting
  if (email.trim() === "") {
    await getDb().execute({
      sql: "DELETE FROM settings WHERE key = ?",
      args: [CONFIG_KEYS.BUSINESS_EMAIL],
    });
    return;
  }

  const normalized = normalizeBusinessEmail(email);

  if (!isValidBusinessEmail(normalized)) {
    throw new Error("Invalid business email format");
  }

  const encrypted = await encrypt(normalized);
  await setSetting(CONFIG_KEYS.BUSINESS_EMAIL, encrypted);
}
