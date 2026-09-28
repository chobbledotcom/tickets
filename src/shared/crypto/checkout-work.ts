import {
  decodeKeyBytes,
  decryptWithKey,
  encryptWithKey,
  getEncryptionKeyBytes,
  parseEncryptedPayload,
} from "#crypto/encryption.ts";
import { generateDataKey, unwrapKey, wrapKey } from "#crypto/keys.ts";
import type { KeyEncrypted, WrappedKey } from "#crypto/sealed.ts";
import { getEnv } from "#shared/env.ts";

/** A row's random data key is wrapped only by the independent work secret. */
export type SealedCheckoutWork = {
  sealed: string;
  wrappedKey: string;
};

const testKey: { value: string | null } = { value: null };

export const setCheckoutWorkKeyForTest = (key: string | null): void => {
  testKey.value = key;
};

export const validateCheckoutWorkKey = (): void => {
  checkoutWorkKeyBytes();
};

const checkoutWorkKeyBytes = (): Uint8Array => {
  const value = testKey.value ?? getEnv("CHECKOUT_WORK_KEY");
  if (!value)
    throw new Error("CHECKOUT_WORK_KEY is required for checkout work");
  const bytes = decodeKeyBytes(value);
  // A second spelling of the database key does not make a second secret.
  const dbBytes = getEncryptionKeyBytes();
  if (bytes.every((byte, index) => byte === dbBytes[index])) {
    throw new Error("CHECKOUT_WORK_KEY must differ from DB_ENCRYPTION_KEY");
  }
  return bytes;
};

const workKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    checkoutWorkKeyBytes() as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

export const encryptCheckoutWork = async (
  plaintext: string,
): Promise<SealedCheckoutWork> => {
  const rowKey = await generateDataKey();
  const key = await workKey();
  const [sealed, wrappedKey] = await Promise.all([
    encryptWithKey(plaintext, rowKey),
    wrapKey(rowKey, key),
  ]);
  return { sealed, wrappedKey };
};

export const decryptCheckoutWork = async (
  work: SealedCheckoutWork,
): Promise<string> => {
  parseEncryptedPayload(work.sealed, "enc:1:", "checkout work");
  parseEncryptedPayload(work.wrappedKey, "wk:1:", "checkout work key");
  return decryptWithKey(
    work.sealed as KeyEncrypted,
    await unwrapKey(work.wrappedKey as WrappedKey, await workKey()),
  );
};
