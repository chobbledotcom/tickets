import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHex, sha256Hex } from "#shared/sha256.ts";

describe("SHA-256 digest", () => {
  test("returns a lowercase fixed-width hex digest", async () => {
    expect(await sha256Hex(new TextEncoder().encode("tickets"))).toBe(
      "45a5c62241eec841f042aee5ae4626a40ea31e8393aa44d0f9ce801d0325ae5d",
    );
  });

  test("hashes one text as its UTF-8 bytes", async () => {
    expect(await sha256Hex("tickets")).toBe(
      "45a5c62241eec841f042aee5ae4626a40ea31e8393aa44d0f9ce801d0325ae5d",
    );
  });
});

describe("keyed HMAC-SHA256 digest", () => {
  test("matches the RFC 4231 vector for a text key and a text message", async () => {
    expect(
      await hmacHex(
        new TextEncoder().encode("Jefe"),
        "what do ya want for nothing?",
      ),
    ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("matches the RFC 4231 vector for raw key and message bytes", async () => {
    expect(
      await hmacHex(
        new Uint8Array(20).fill(0x0b),
        new TextEncoder().encode("Hi There"),
      ),
    ).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  test("changes with the key, so a digest without its key admits nothing", async () => {
    const one = await hmacHex(new Uint8Array(32).fill(1), "ticket");
    expect(one).not.toBe(await hmacHex(new Uint8Array(32).fill(2), "ticket"));
  });
});
