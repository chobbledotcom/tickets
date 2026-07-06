import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromBase64 } from "#shared/crypto/utils.ts";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  decryptField,
  encryptField,
} from "#shared/sms/e2e.ts";

const PASSPHRASE = "correct horse battery staple";

describe("sms e2e encryptField", () => {
  it("produces the SMS Gate encoded format", async () => {
    const encoded = await encryptField("hello", PASSPHRASE);
    expect(encoded.startsWith("$aes-256-cbc/pbkdf2-sha1$i=")).toBe(true);

    const parts = encoded
      .slice("$aes-256-cbc/pbkdf2-sha1$i=".length)
      .split("$");
    expect(parts).toHaveLength(3);
    const [iterations, saltB64] = parts;
    expect(Number(iterations)).toBe(DEFAULT_PBKDF2_ITERATIONS);
    // Salt is 16 bytes (also the IV)
    expect(fromBase64(saltB64!)).toHaveLength(16);
  });

  it("uses a fresh random salt per call (non-deterministic ciphertext)", async () => {
    const a = await encryptField("hello", PASSPHRASE);
    const b = await encryptField("hello", PASSPHRASE);
    expect(a).not.toBe(b);
  });

  it("records a custom iteration count in the encoded output", async () => {
    const encoded = await encryptField("hello", PASSPHRASE, 1000);
    expect(encoded.startsWith("$aes-256-cbc/pbkdf2-sha1$i=1000$")).toBe(true);
  });
});

describe("sms e2e round trip", () => {
  it("decrypts what it encrypted", async () => {
    const encoded = await encryptField("Hello, world!", PASSPHRASE);
    expect(await decryptField(encoded, PASSPHRASE)).toBe("Hello, world!");
  });

  it("round-trips a phone number", async () => {
    const encoded = await encryptField("+447700900123", PASSPHRASE);
    expect(await decryptField(encoded, PASSPHRASE)).toBe("+447700900123");
  });

  it("round-trips unicode and emoji", async () => {
    const msg = "Tickets ready 🎟️ — café déjà vu";
    const encoded = await encryptField(msg, PASSPHRASE);
    expect(await decryptField(encoded, PASSPHRASE)).toBe(msg);
  });

  it("round-trips the empty string", async () => {
    const encoded = await encryptField("", PASSPHRASE);
    expect(await decryptField(encoded, PASSPHRASE)).toBe("");
  });

  it("round-trips with a custom iteration count", async () => {
    const encoded = await encryptField("scheduled", PASSPHRASE, 2048);
    expect(await decryptField(encoded, PASSPHRASE)).toBe("scheduled");
  });
});

describe("sms e2e decryptField errors", () => {
  it("rejects a bad algorithm prefix", async () => {
    await expect(decryptField("$aes-128-gcm$nope", PASSPHRASE)).rejects.toThrow(
      "bad prefix",
    );
  });

  it("rejects a wrong number of segments", async () => {
    await expect(
      decryptField("$aes-256-cbc/pbkdf2-sha1$i=75000$onlysalt", PASSPHRASE),
    ).rejects.toThrow("expected 3 segments");
  });

  it("rejects a non-numeric iteration count", async () => {
    await expect(
      decryptField("$aes-256-cbc/pbkdf2-sha1$i=abc$c2FsdA==$Y3Q=", PASSPHRASE),
    ).rejects.toThrow("bad iteration count");
  });

  it("rejects a zero iteration count", async () => {
    await expect(
      decryptField("$aes-256-cbc/pbkdf2-sha1$i=0$c2FsdA==$Y3Q=", PASSPHRASE),
    ).rejects.toThrow("bad iteration count");
  });

  it("does not recover the plaintext with the wrong passphrase", async () => {
    const plaintext = "secret";
    const encoded = await encryptField(plaintext, PASSPHRASE);

    try {
      expect(await decryptField(encoded, "wrong passphrase")).not.toBe(
        plaintext,
      );
    } catch {
      return;
    }
  });
});
