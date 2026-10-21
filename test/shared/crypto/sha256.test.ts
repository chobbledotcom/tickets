/** The scan digest module, pinned to the exact bytes both sides of the
 * offline check-in run. The server's list and the device's scan must agree
 * digest for digest. The vectors here fix the two constructions for every
 * future caller. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHex, importHmacKey, sha256Hex } from "#crypto/sha256.ts";

describe("the scanner digest helpers", () => {
  test("sha256Hex answers the standard test vector", async () => {
    // FIPS 180's own example: "abc" digests to this hex in every SHA-256
    // implementation, so a wrong hash step cannot pass unnoticed.
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("importHmacKey and hmacHex answer the RFC 4231 test vector", async () => {
    // RFC 4231 case 2: HMAC-SHA256 over "what do ya want for nothing?"
    // under the key "Jefe". The device and the server must both land here.
    const key = await importHmacKey(new TextEncoder().encode("Jefe"));
    expect(await hmacHex(key, "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  test("hmacHex imports raw key bytes itself", async () => {
    // The one-off digest path hands the derived key bytes straight over.
    const keyBytes = new TextEncoder().encode("Jefe");
    expect(await hmacHex(keyBytes, "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  test("hmacHex differs from sha256Hex for the same input", async () => {
    // The keyed form is not a plain digest: a stolen list of plain digests
    // matches nothing the keyed form answers.
    const value = "a ticket token";
    const key = new TextEncoder().encode("Jefe");
    expect(await hmacHex(key, value)).not.toBe(await sha256Hex(value));
  });
});
