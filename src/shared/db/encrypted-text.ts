import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";

/**
 * Decrypt a stored encrypted-text value, honouring the `''` = "no value"
 * convention (matches `col.encryptedText`'s read — an empty column never
 * decrypts). For encrypted-text values read outside the table layer, e.g.
 * projected columns and narrow hand-written SELECTs. A missing projection
 * (undefined) reads as "" too, so a stray un-projected SELECT degrades
 * gracefully.
 */
export const decryptTextOrEmpty = (
  value: EnvKeyEncrypted | "" | undefined,
): Promise<string> | string =>
  value === "" || value === undefined ? "" : decrypt(value);
