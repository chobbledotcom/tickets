import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptWithKey } from "#shared/crypto/encryption.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  generateDataKey,
  generateKeyPair,
  hybridEncrypt,
  importPublicKey,
  unwrapKey,
  wrapKey,
} from "#shared/crypto/keys.ts";
import {
  deriveOwnerKek,
  privateKeyFromDataKey,
} from "#shared/crypto/owner-kek.ts";
import type { PasswordHash } from "#shared/crypto/sealed.ts";

const hash = "stored-hash" as PasswordHash;
const password = "owner-password";

describe("deriveOwnerKek", () => {
  test("v2 dispatch matches deriveKEKFromPassword", async () => {
    const kek = await deriveOwnerKek(password, hash, 2);
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, kek);
    // The same KEK (under the v2 scheme) unwraps the wrapped key.
    const recovered = await unwrapKey(
      wrapped,
      await deriveKEKFromPassword(password, hash),
    );
    expect(recovered).toBeDefined();
  });

  test("v1 dispatch matches deriveKEK", async () => {
    const kek = await deriveOwnerKek(password, hash, 1);
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, kek);
    const recovered = await unwrapKey(wrapped, await deriveKEK(hash));
    expect(recovered).toBeDefined();
  });

  test("v1 and v2 produce different KEKs", async () => {
    const v2Kek = await deriveOwnerKek(password, hash, 2);
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, v2Kek);
    // A v1 KEK cannot unwrap a key wrapped under the v2 KEK.
    let threw = false;
    try {
      await unwrapKey(wrapped, await deriveKEK(hash));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("privateKeyFromDataKey", () => {
  test("recovers a private key that decrypts public-key ciphertext", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    const dataKey = await generateDataKey();
    const wrappedPrivateKey = await encryptWithKey(privateKey, dataKey);

    const recovered = await privateKeyFromDataKey(dataKey, wrappedPrivateKey);
    const pubKey = await importPublicKey(publicKey);
    const ciphertext = await hybridEncrypt("attendee PII", pubKey);
    // Only the recovered private key can decrypt what the public key encrypted.
    const { decryptWithOwnerKey } = await import("#shared/crypto/keys.ts");
    expect(await decryptWithOwnerKey(ciphertext, recovered)).toBe(
      "attendee PII",
    );
  });
});
