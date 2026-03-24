import { settings } from "#lib/db/settings.ts";

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
 * Updates the business email in the database.
 * Pass empty string to clear the business email.
 * Email is encrypted at rest.
 */
export async function updateBusinessEmail(email: string): Promise<void> {
  if (email.trim() === "") {
    await settings.update.businessEmail("");
    return;
  }

  const normalized = normalizeBusinessEmail(email);

  if (!isValidBusinessEmail(normalized)) {
    throw new Error("Invalid business email format");
  }

  await settings.update.businessEmail(normalized);
}
