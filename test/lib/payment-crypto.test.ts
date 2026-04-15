import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  computeHmacSha256,
  hmacToBase64,
  hmacToHex,
  secureCompare,
} from "#lib/payment-crypto.ts";

const encode = (s: string) => new TextEncoder().encode(s);

describe("payment-crypto", () => {
  describe("secureCompare", () => {
    test("returns true for identical strings", () => {
      expect(secureCompare("abc123", "abc123")).toBe(true);
    });

    test("returns false for strings differing in one character", () => {
      expect(secureCompare("abc123", "abc124")).toBe(false);
    });

    test("returns false for strings differing in first character", () => {
      expect(secureCompare("Xbcdef", "abcdef")).toBe(false);
    });

    test("returns false for strings of different lengths", () => {
      // Must differ regardless of which argument is longer: both orderings matter
      // because the impl must not leak length via early-return.
      expect(secureCompare("short", "longer")).toBe(false);
      expect(secureCompare("longer", "short")).toBe(false);
    });

    test("returns true when both strings are empty", () => {
      expect(secureCompare("", "")).toBe(true);
    });

    test("returns false when only one string is empty", () => {
      expect(secureCompare("", "nonempty")).toBe(false);
      expect(secureCompare("nonempty", "")).toBe(false);
    });

    test("returns true for identical hex signatures (webhook use case)", () => {
      // Realistic case: comparing 64-char hex HMAC signatures
      const sig = "a".repeat(64);
      expect(secureCompare(sig, sig)).toBe(true);
    });

    test("returns false when hex signatures differ only in final char", () => {
      // A length-aware early exit would pass this; this guards against that.
      const a = `${"a".repeat(63)}0`;
      const b = `${"a".repeat(63)}1`;
      expect(secureCompare(a, b)).toBe(false);
    });
  });

  describe("computeHmacSha256", () => {
    // RFC 4231 test vector #1: proves algorithm correctness against the spec.
    // key = 0x0b * 20 ("\v\v..."), data = "Hi There"
    test("matches RFC 4231 test vector 1", async () => {
      const key = "\x0b".repeat(20);
      const buf = await computeHmacSha256(encode("Hi There"), key);
      expect(hmacToHex(buf)).toBe(
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
      );
    });

    // RFC 4231 test vector #2: short key, short data
    test("matches RFC 4231 test vector 2", async () => {
      const buf = await computeHmacSha256(
        encode("what do ya want for nothing?"),
        "Jefe",
      );
      expect(hmacToHex(buf)).toBe(
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      );
    });

    test("produces different signatures for different payloads under same secret", async () => {
      const a = await computeHmacSha256(encode("payload-a"), "secret");
      const b = await computeHmacSha256(encode("payload-b"), "secret");
      expect(hmacToHex(a)).not.toBe(hmacToHex(b));
    });

    test("produces different signatures for same payload under different secrets", async () => {
      const a = await computeHmacSha256(encode("payload"), "secret1");
      const b = await computeHmacSha256(encode("payload"), "secret2");
      expect(hmacToHex(a)).not.toBe(hmacToHex(b));
    });

    test("handles empty payload", async () => {
      // HMAC-SHA256(key="key", data="") — verified against openssl:
      //   printf '' | openssl dgst -sha256 -hmac 'key' -hex
      const buf = await computeHmacSha256(encode(""), "key");
      expect(hmacToHex(buf)).toBe(
        "5d5d139563c95b5967b9bd9a8c9b233a9dedb45072794cd232dc1b74832607d0",
      );
    });

    test("handles multi-byte UTF-8 payload", async () => {
      // Real webhook payloads often contain non-ASCII (customer names, notes).
      // Expected value produced independently by openssl:
      //   printf 'café ☕' | openssl dgst -sha256 -hmac 'secret' -hex
      const buf = await computeHmacSha256(encode("café ☕"), "secret");
      expect(hmacToHex(buf)).toBe(
        "1f82af940aec2372da8d0f760cc035b21d215708c63be7b4e8ef857ee3d48943",
      );
    });
  });

  describe("hmacToHex", () => {
    test("pads single-digit hex bytes to two chars", () => {
      const buf = new Uint8Array([0, 1, 15]).buffer;
      expect(hmacToHex(buf)).toBe("00010f");
    });

    test("emits full-byte values without truncation", () => {
      const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xff]).buffer;
      expect(hmacToHex(buf)).toBe("deadbeefff");
    });

    test("uses lowercase hex (required by Stripe signature format)", () => {
      const buf = new Uint8Array([0xab, 0xcd]).buffer;
      expect(hmacToHex(buf)).toBe("abcd");
    });

    test("returns empty string for empty buffer", () => {
      expect(hmacToHex(new Uint8Array([]).buffer)).toBe("");
    });
  });

  describe("hmacToBase64", () => {
    test("matches standard base64 encoding of ASCII bytes", () => {
      // "Hello" → [72, 101, 108, 108, 111]
      const buf = new Uint8Array([72, 101, 108, 108, 111]).buffer;
      expect(hmacToBase64(buf)).toBe(btoa("Hello"));
    });

    test("encodes full byte range (0x00–0xFF) without corruption", () => {
      // Square's signature uses base64; high-bit bytes must survive encoding.
      const bytes = new Uint8Array([0, 128, 255]);
      const b64 = hmacToBase64(bytes.buffer);
      const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      expect(Array.from(decoded)).toEqual([0, 128, 255]);
    });

    test("returns empty string for empty buffer", () => {
      expect(hmacToBase64(new Uint8Array([]).buffer)).toBe("");
    });
  });

  describe("provider signature flows", () => {
    // These expected values were produced by openssl, independently of this
    // codebase — matching them proves the end-to-end flow (encode → HMAC →
    // hex/base64) agrees with the reference implementation Stripe and Square
    // use on their end. Recompute with:
    //   printf '<payload>' | openssl dgst -sha256 -hmac '<secret>' -hex
    //   printf '<payload>' | openssl dgst -sha256 -hmac '<secret>' -binary | base64

    test("Stripe-style hex signature matches openssl reference", async () => {
      // Stripe signs `${timestamp}.${payload}` with the webhook secret
      const secret = "whsec_test_secret";
      const payload = '1700000000.{"id":"evt_test","type":"payment_intent"}';
      const signature = hmacToHex(
        await computeHmacSha256(encode(payload), secret),
      );
      expect(signature).toBe(
        "acbf7cbf29490215c6bafd38d3a52bf27e23c8e0ccae3672c46988686424ecfb",
      );
    });

    test("Stripe-style signature rejects tampered payload", async () => {
      const secret = "whsec_test_secret";
      const original = '1700000000.{"id":"evt_test","amount":1000}';
      const tampered = '1700000000.{"id":"evt_test","amount":9999}';
      const sigOriginal = hmacToHex(
        await computeHmacSha256(encode(original), secret),
      );
      const sigTampered = hmacToHex(
        await computeHmacSha256(encode(tampered), secret),
      );
      expect(secureCompare(sigOriginal, sigTampered)).toBe(false);
    });

    test("Stripe-style signature rejects wrong secret", async () => {
      // Attacker without the webhook secret cannot forge a matching signature.
      const payload = '1700000000.{"id":"evt_test","amount":1000}';
      const sigReal = hmacToHex(
        await computeHmacSha256(encode(payload), "whsec_real_secret"),
      );
      const sigGuessed = hmacToHex(
        await computeHmacSha256(encode(payload), "whsec_wrong_secret"),
      );
      expect(secureCompare(sigReal, sigGuessed)).toBe(false);
    });

    test("Square-style base64 signature matches openssl reference", async () => {
      // Square signs `${notificationUrl}${payload}` and sends the result base64
      const secret = "square_signing_key";
      const url = "https://example.com/webhook";
      const payload = '{"type":"payment.updated"}';
      const signature = hmacToBase64(
        await computeHmacSha256(encode(url + payload), secret),
      );
      expect(signature).toBe("Ueb2OY8fGwUjI6YeHenKIn/vGU7+BujNk3TJugwLe5I=");
    });

    test("Square-style signature rejects tampered notification URL", async () => {
      // Square binds the URL into the signature so attackers can't replay a
      // valid signed payload against a different endpoint.
      const secret = "square_signing_key";
      const payload = '{"type":"payment.updated"}';
      const sigReal = hmacToBase64(
        await computeHmacSha256(
          encode("https://example.com/webhook" + payload),
          secret,
        ),
      );
      const sigReplayed = hmacToBase64(
        await computeHmacSha256(
          encode("https://evil.example.com/webhook" + payload),
          secret,
        ),
      );
      expect(secureCompare(sigReal, sigReplayed)).toBe(false);
    });
  });
});
