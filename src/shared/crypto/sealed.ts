/**
 * A sealed string is an ordinary string whose TYPE names which helper made it.
 * Handing a function plaintext, or a value sealed under the wrong scheme, is
 * then a compile error instead of unreadable data at rest.
 *
 * Only the crypto helpers produce sealed values, so never build one with a cast
 * in application code. The one sanctioned cast is `col.encrypted`'s read
 * transform in table.ts, where raw DB values re-enter the typed world.
 */

declare const sealedKind: unique symbol;
declare const sealedPlain: unique symbol;

/** A string produced by a crypto helper; `Kind` names which one. Reversible
 * kinds also carry `Plain` — the type the value opens back into — so a nested
 * seal survives the round trip (e.g. `EnvKeyEncrypted<PasswordHash>` decrypts
 * to a `PasswordHash`, not a bare string). */
export type Sealed<
  Kind extends string,
  Plain extends string = string,
> = string & {
  readonly [sealedKind]: Kind;
  readonly [sealedPlain]: Plain;
};

/** Symmetric ciphertext under the env `DB_ENCRYPTION_KEY` (`enc:1:` values
 * from `encrypt()`); `decrypt()` opens it back into `Plain`. */
export type EnvKeyEncrypted<Plain extends string = string> = Sealed<
  "env-key",
  Plain
>;

/** Symmetric ciphertext under a specific AES `CryptoKey` — a per-row data key
 * or the owner's DATA_KEY (`enc:1:` values from `encryptWithKey()`); read
 * back with `decryptWithKey()` and the same key. */
export type KeyEncrypted<Plain extends string = string> = Sealed<
  "aes-key",
  Plain
>;

/** Hybrid RSA+AES ciphertext under the site owner's public key (`hyb:1:`
 * values from `encryptWithOwnerKey()`); only the owner's private key reads it
 * back. Attendee PII, message bodies, and template blobs live in this form. */
export type OwnerKeyEncrypted<Plain extends string = string> = Sealed<
  "owner-key",
  Plain
>;

/** Wrapped (encrypted) key material (`wk:1:` values from `wrapKey()` and
 * friends); unwrapped back into a `CryptoKey`, never displayed. */
export type WrappedKey = Sealed<"wrapped-key">;

/** Deterministic HMAC blind index from `hmacHash()` — lets a lookup match an
 * encrypted value without decrypting anything. Not reversible. */
export type BlindIndex = Sealed<"blind-index">;

/** PBKDF2 password hash from `hashPassword()`; checked with
 * `verifyPassword()`, never reversed. */
export type PasswordHash = Sealed<"password-hash">;

/** SHA-256 session-token hash from `hashSessionToken()` — the stored lookup
 * key for a session; the raw token never rests in the database. */
export type TokenHash = Sealed<"token-hash">;
