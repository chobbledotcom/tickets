import * as v from "valibot";
import { settings } from "#shared/db/settings.ts";

/**
 * Email validation — the single source of truth for what counts as a valid
 * email address across the app, plus the branded ValidEmail type and helpers
 * for working with one. Format checks are delegated to valibot's `email`
 * action; other value-type validators (phone, slug, …) can follow the same
 * shape (schema + ValidXxx + parseXxx + isValidXxx) as the rest of the app's
 * validation migrates to valibot.
 */

/**
 * Canonical email schema used across the app: `local@host.tld`. valibot's
 * `email` action guarantees a non-empty local part and a host containing at
 * least one dot. The input is trimmed and lowercased before validation, and the
 * output is branded as ValidEmail so a value can only be produced by passing
 * validation. All email validation that needs a normalized, carry-onward value
 * goes through this (see isValidEmail / parseEmail).
 */
export const EmailSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.email(),
  v.brand("ValidEmail"),
);

/**
 * Format-only email schema: validates an address exactly as typed, without
 * trimming or lowercasing. Used by field validators that check raw user input
 * (see validateEmail in #templates/fields.ts).
 */
export const EmailFormatSchema = v.pipe(v.string(), v.email());

/**
 * An email address that has passed validation (a non-empty host containing at
 * least one dot) and been normalized (trimmed, lowercased).
 *
 * The brand exists so host-extraction code can require this type rather than a
 * bare string: the presence of a host is then guaranteed by the compiler, so
 * such code needs no fallback for addresses that lack one. The only way to
 * obtain a value is through parseEmail, which performs the validation.
 */
export type ValidEmail = v.InferOutput<typeof EmailSchema>;

/** Whether a string is a valid email (trimmed) per EmailSchema. */
export function isValidEmail(email: string): boolean {
  return v.safeParse(EmailSchema, email).success;
}

/**
 * Parse and normalize a candidate email, returning the branded ValidEmail when
 * it is valid or null otherwise. Use this in preference to isValidEmail when the
 * validated address needs to be carried onward in a type-safe way.
 */
export function parseEmail(email: string): ValidEmail | null {
  const result = v.safeParse(EmailSchema, email);
  return result.success ? result.output : null;
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
 * Updates the business email in the database.
 * Pass empty string to clear the business email.
 * Email is encrypted at rest.
 */
export async function updateBusinessEmail(email: string): Promise<void> {
  if (email.trim() === "") {
    await settings.update.businessEmail("");
    return;
  }

  const parsed = parseEmail(email);

  if (!parsed) {
    throw new Error("Invalid business email format");
  }

  await settings.update.businessEmail(parsed);
}
