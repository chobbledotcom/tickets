import { settings } from "#shared/db/settings.ts";

/**
 * An email address that has passed validation (a non-empty host containing at
 * least one dot) and been normalized (trimmed, lowercased).
 *
 * The brand exists so host-extraction code can require this type rather than a
 * bare string: the presence of a host is then guaranteed by the compiler, so
 * such code needs no fallback for addresses that lack one. The only way to
 * obtain a value is through parseEmail, which performs the validation.
 */
export type ValidEmail = string & { readonly __validEmail: unique symbol };

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
 * Parse and normalize a candidate email, returning the branded ValidEmail when
 * it is valid or null otherwise. Use this in preference to isValidBusinessEmail
 * when the validated address needs to be carried onward in a type-safe way.
 */
export function parseEmail(email: string): ValidEmail | null {
  const normalized = normalizeBusinessEmail(email);
  return isValidBusinessEmail(normalized) ? (normalized as ValidEmail) : null;
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
