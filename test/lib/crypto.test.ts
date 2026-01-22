import { describe, expect, it } from "bun:test";
import { constantTimeEqual, generateSecureToken } from "#lib/crypto.ts";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("hello", "hello")).toBe(true);
    expect(constantTimeEqual("test123", "test123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(constantTimeEqual("hello", "hallo")).toBe(false);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("aaa", "aab")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(constantTimeEqual("hello", "hell")).toBe(false);
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("test", "testing")).toBe(false);
  });

  it("handles special characters", () => {
    expect(constantTimeEqual("!@#$%", "!@#$%")).toBe(true);
    expect(constantTimeEqual("!@#$%", "!@#$&")).toBe(false);
  });

  it("handles unicode characters", () => {
    expect(constantTimeEqual("héllo", "héllo")).toBe(true);
    expect(constantTimeEqual("héllo", "hèllo")).toBe(false);
  });
});

describe("generateSecureToken", () => {
  it("returns a non-empty string", () => {
    const token = generateSecureToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("returns base64url encoded string without padding", () => {
    const token = generateSecureToken();
    // base64url uses only alphanumeric, -, and _
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // Should not contain +, /, or =
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSecureToken());
    }
    // All 100 tokens should be unique
    expect(tokens.size).toBe(100);
  });

  it("generates tokens of consistent length", () => {
    // 32 bytes = 256 bits, base64 encodes 6 bits per char
    // 256/6 = ~43 chars (without padding)
    const token = generateSecureToken();
    expect(token.length).toBe(43);
  });
});
