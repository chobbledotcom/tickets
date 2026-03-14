import { col } from "#lib/db/table.ts";

type EncryptFn = (v: string) => Promise<string>;
type DecryptFn = (v: string) => Promise<string>;

/** Shared columns for tables with encrypted `slug` + blind-index `slug_index`. */
export const idAndEncryptedSlugSchema = (encrypt: EncryptFn, decrypt: DecryptFn) => ({
  id: col.generated<number>(),
  slug: col.encrypted<string>(encrypt, decrypt),
  slug_index: col.simple<string>(),
});

/** Shared encrypted `name` column for tables that store a display name. */
export const encryptedNameSchema = (encrypt: EncryptFn, decrypt: DecryptFn) => ({
  name: col.encrypted<string>(encrypt, decrypt),
});
