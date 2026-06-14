import { settings } from "#shared/db/settings.ts";

/**
 * Canonical email-address format used across the app: `local@host.tld`. More
 * permissive than strict RFC 5322, but it guarantees a non-empty local part and
 * a host containing at least one dot. This is the single source of truth — all
 * email validation goes through it (see isValidBusinessEmail / parseEmail and
 * validateEmail in #templates/fields.ts).
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  return EMAIL_REGEX.test(email.trim());
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
 * Host (everything after the last `@`) of a validated address. The ValidEmail
 * type guarantees a host is present, so there is no empty-host case to handle
 * and the compiler forbids passing a raw, unvalidated string.
 */
export function emailHost(email: ValidEmail): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Local part (everything before the last `@`) of a validated address. */
export function emailLocalPart(email: ValidEmail): string {
  return email.slice(0, email.lastIndexOf("@"));
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
