/**
 * The broken-image fallback.
 *
 * An image record whose stored filename cannot be read is a data problem to
 * repair, not a reason to take the whole page down. Every place that decrypts
 * an image filename goes through the helpers here: a filename that reads back
 * fine is returned as-is, and a broken one is reported loudly (error log,
 * ntfy, Sentry, activity log — via `logError`) and swapped for
 * {@link BROKEN_IMAGE_FILENAME}, whose image URL serves {@link BROKEN_IMAGE_PNG}
 * — a 1×1 red pixel — so the page still renders and the red pixel points an
 * operator at the record to fix.
 */

import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { fromBase64 } from "#crypto/utils.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  isNonEmptyString,
  type NonEmptyString,
  nonEmptyString,
} from "#shared/validation/string.ts";

/** The stand-in filename a broken image record reads back as. Uploaded files
 * are always `<uuid>.webp`, so this name can never collide with a real one. */
export const BROKEN_IMAGE_FILENAME: NonEmptyString & "broken-image.png" =
  nonEmptyString("broken-image.png");

/** A 1×1 red pixel PNG (69 bytes) — served for {@link BROKEN_IMAGE_FILENAME}
 * and for a stored file that is missing or unreadable. */
export const BROKEN_IMAGE_PNG: Uint8Array = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
);

/** Report a broken image through the classified error log (which also reaches
 * ntfy, Sentry, and the admin activity log). Images should never go missing or
 * become unreadable, so every fallback to the red pixel is reported this way. */
export const reportBrokenImage = (detail: string, error?: unknown): void => {
  logError({
    code: ErrorCode.IMAGE_BROKEN,
    detail: error === undefined ? detail : `${detail} (${errorMessage(error)})`,
    error,
  });
};

/**
 * Decrypt a stored image filename that must exist. When the stored value will
 * not decrypt, or decrypts to an empty value, this reports the broken record
 * (naming `source`, e.g. "image 12 filename") and returns
 * {@link BROKEN_IMAGE_FILENAME} instead of failing the page.
 */
export const decryptImageFilename = async (
  stored: string,
  source: string,
): Promise<NonEmptyString> => {
  try {
    const filename = await decrypt(stored as EnvKeyEncrypted);
    if (isNonEmptyString(filename)) return filename;
    reportBrokenImage(`${source} decrypted to an empty value`);
  } catch (error) {
    reportBrokenImage(`${source} could not be decrypted`, error);
  }
  return BROKEN_IMAGE_FILENAME;
};

/**
 * Decrypt a projected image filename where "" (or a missing projection) is the
 * expected "this item has no image" case and passes through unchanged. A
 * non-empty stored value must read back as a real filename, so it takes the
 * same broken-image fallback as {@link decryptImageFilename}.
 */
export const decryptImageFilenameOrEmpty = (
  stored: string | undefined,
  source: string,
): Promise<string> | string =>
  stored === undefined || stored === ""
    ? ""
    : decryptImageFilename(stored, source);
