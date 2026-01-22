/**
 * Column-level encryption utilities using AES-256-GCM
 * Encrypts sensitive data before storing in database
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16;

let encryptionKey: Buffer | null = null;

/**
 * Get encryption key from environment, cached after first call
 */
const getEncryptionKey = (): Buffer => {
  if (!encryptionKey) {
    const keyString = process.env.DB_ENCRYPTION_KEY;
    if (!keyString) {
      throw new Error("DB_ENCRYPTION_KEY environment variable is required");
    }
    // Key should be 32 bytes (256 bits) encoded as base64
    encryptionKey = Buffer.from(keyString, "base64");
    if (encryptionKey.length !== 32) {
      throw new Error(
        "DB_ENCRYPTION_KEY must be 32 bytes (256 bits) encoded as base64",
      );
    }
  }
  return encryptionKey;
};

/**
 * Reset encryption key cache (for testing)
 */
export const resetEncryptionKey = (): void => {
  encryptionKey = null;
};

/**
 * Encrypt a plaintext string
 * Returns format: base64(iv):base64(ciphertext):base64(authTag)
 */
export const encrypt = (plaintext: string): string => {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${encrypted.toString("base64")}:${authTag.toString("base64")}`;
};

/**
 * Decrypt an encrypted string
 * Expects format: base64(iv):base64(ciphertext):base64(authTag)
 */
export const decrypt = (encrypted: string): string => {
  const key = getEncryptionKey();
  const parts = encrypted.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const [ivB64, ciphertextB64, authTagB64] = parts;
  if (!ivB64 || !ciphertextB64 || !authTagB64) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length");
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid auth tag length");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

/**
 * Encrypt a value if not null, otherwise return null
 */
export const encryptNullable = (value: string | null): string | null => {
  if (value === null) return null;
  return encrypt(value);
};

/**
 * Decrypt a value if not null, otherwise return null
 */
export const decryptNullable = (value: string | null): string | null => {
  if (value === null) return null;
  return decrypt(value);
};
