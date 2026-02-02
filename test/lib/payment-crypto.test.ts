import { describe, expect, test } from "#test-compat";
import {
  computeHmacSha256,
  hmacToBase64,
  hmacToHex,
  secureCompare,
} from "#lib/payment-crypto.ts";

describe("payment-crypto", () => {
  describe("secureCompare", () => {
    test("returns true for identical strings", () => {
      expect(secureCompare("abc123", "abc123")).toBe(true);
    });

    test("returns false for different strings of same length", () => {
      expect(secureCompare("abc123", "abc124")).toBe(false);
    });

    test("returns false for strings of different lengths", () => {
      expect(secureCompare("short", "longer")).toBe(false);
    });

    test("returns false when first string is longer", () => {
      expect(secureCompare("longer", "short")).toBe(false);
    });

    test("returns false for completely different strings of same length", () => {
      expect(secureCompare("aaaaaa", "zzzzzz")).toBe(false);
    });

    test("handles strings differing only in first character", () => {
      expect(secureCompare("Xbcdef", "abcdef")).toBe(false);
    });

    test("handles strings differing only in last character", () => {
      expect(secureCompare("abcdeX", "abcdef")).toBe(false);
    });
  });

  describe("computeHmacSha256", () => {
    test("returns an ArrayBuffer", async () => {
      const result = await computeHmacSha256("data", "secret");
      expect(result instanceof ArrayBuffer).toBe(true);
    });

    test("returns 32 bytes (SHA-256 output size)", async () => {
      const result = await computeHmacSha256("data", "secret");
      expect(result.byteLength).toBe(32);
    });

    test("produces deterministic output for same inputs", async () => {
      const a = await computeHmacSha256("hello", "key");
      const b = await computeHmacSha256("hello", "key");
      expect(hmacToHex(a)).toBe(hmacToHex(b));
    });

    test("produces different output for different data", async () => {
      const a = await computeHmacSha256("hello", "key");
      const b = await computeHmacSha256("world", "key");
      expect(hmacToHex(a)).not.toBe(hmacToHex(b));
    });

    test("produces different output for different secrets", async () => {
      const a = await computeHmacSha256("data", "secret1");
      const b = await computeHmacSha256("data", "secret2");
      expect(hmacToHex(a)).not.toBe(hmacToHex(b));
    });

    test("produces known HMAC-SHA256 value", async () => {
      // Known test vector: HMAC-SHA256("test", "secret")
      const result = await computeHmacSha256("test", "secret");
      const hex = hmacToHex(result);
      expect(hex).toBe(
        "0329a06b62cd16b33eb6792be8c60b158d89a2ee3a876fce9a881ebb488c0914",
      );
    });
  });

  describe("hmacToHex", () => {
    test("converts single byte to two hex chars", () => {
      const buf = new Uint8Array([255]).buffer;
      expect(hmacToHex(buf)).toBe("ff");
    });

    test("pads single-digit hex values with leading zero", () => {
      const buf = new Uint8Array([0, 1, 15]).buffer;
      expect(hmacToHex(buf)).toBe("00010f");
    });

    test("converts known bytes to expected hex", () => {
      const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
      expect(hmacToHex(buf)).toBe("deadbeef");
    });

    test("produces lowercase hex", () => {
      const buf = new Uint8Array([0xAB, 0xCD]).buffer;
      expect(hmacToHex(buf)).toBe("abcd");
    });
  });

  describe("hmacToBase64", () => {
    test("converts known bytes to expected base64", () => {
      // "Hello" in bytes: [72, 101, 108, 108, 111]
      const buf = new Uint8Array([72, 101, 108, 108, 111]).buffer;
      expect(hmacToBase64(buf)).toBe(btoa("Hello"));
    });

    test("produces valid base64 characters", () => {
      const buf = new Uint8Array([0, 128, 255]).buffer;
      const result = hmacToBase64(buf);
      expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test("round-trips with atob", () => {
      const original = new Uint8Array([10, 20, 30, 40, 50]);
      const base64 = hmacToBase64(original.buffer);
      const decoded = atob(base64);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
      expect(Array.from(bytes)).toEqual(Array.from(original));
    });
  });

  describe("end-to-end: compute then convert", () => {
    test("computeHmacSha256 + hmacToHex produces consistent hex signature", async () => {
      const buf = await computeHmacSha256("payload", "secret");
      const hex = hmacToHex(buf);
      expect(hex.length).toBe(64); // 32 bytes = 64 hex chars
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });

    test("computeHmacSha256 + hmacToBase64 produces consistent base64 signature", async () => {
      const buf = await computeHmacSha256("payload", "secret");
      const b64 = hmacToBase64(buf);
      expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
      // Base64 of 32 bytes is 44 chars (with padding)
      expect(b64.length).toBe(44);
    });
  });
});
