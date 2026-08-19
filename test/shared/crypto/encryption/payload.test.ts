/**
 * How a prefixed payload is taken apart, and what it refuses.
 *
 * `parseEncryptedPayload` is the boundary every stored `prefix:iv:ciphertext`
 * value comes back through, and its two guards are what stop a value that is
 * not ours being read as if it were. Both throw, and both messages name the
 * label the caller passed, so a failure says which kind of value was wrong.
 */

import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { encrypt, parseEncryptedPayload } from "#crypto/encryption.ts";
import { toBase64 } from "#crypto/utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const PREFIX = "enc:1:";

describeWithEnv("parseEncryptedPayload", { encryptionKey: true }, () => {
  it("splits a real payload at the separator", async () => {
    const sealed = await encrypt("secret");
    const { ciphertext, iv } = parseEncryptedPayload(
      sealed,
      PREFIX,
      "encrypted data",
    );
    expect(iv.length).toBe(12);
    expect(ciphertext.length).toBeGreaterThan(0);
    // The parts are the payload's own, in order: rebuilding it gets the
    // original string back.
    expect(`${PREFIX}${toBase64(iv)}:${toBase64(ciphertext)}`).toBe(sealed);
  });

  it("refuses a value that does not carry the prefix", () => {
    expect(() =>
      parseEncryptedPayload("other:1:abc:def", PREFIX, "a note"),
    ).toThrow("Invalid a note format");
  });

  it("refuses a value with no separator after the prefix", () => {
    expect(() =>
      parseEncryptedPayload(`${PREFIX}abcdef`, PREFIX, "a wrapped key"),
    ).toThrow("Invalid a wrapped key format: missing IV separator");
  });

  it("tells the two failures apart", () => {
    // The missing-separator message is the more specific one, so a payload
    // that has the prefix must never report the plain format error.
    expect(() =>
      parseEncryptedPayload(`${PREFIX}abcdef`, PREFIX, "a note"),
    ).not.toThrow(/^Invalid a note format$/);
  });

  it("names whatever label the caller gave it, on either failure", () => {
    expect(() => parseEncryptedPayload("nope", PREFIX, "a ticket")).toThrow(
      "Invalid a ticket format",
    );
    expect(() =>
      parseEncryptedPayload(`${PREFIX}abcdef`, PREFIX, "a ticket"),
    ).toThrow("Invalid a ticket format: missing IV separator");
  });

  it("keeps an empty ciphertext rather than inventing one", () => {
    const { ciphertext, iv } = parseEncryptedPayload(
      `${PREFIX}${toBase64(new Uint8Array(12) as Uint8Array<ArrayBuffer>)}:`,
      PREFIX,
      "a note",
    );
    expect(iv.length).toBe(12);
    expect(ciphertext.length).toBe(0);
  });
});
