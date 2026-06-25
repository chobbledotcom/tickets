import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  base64ToBase64Url,
  constantTimeEqual,
  fromBase64,
  fromBase64Url,
  generateSecureToken,
  generateTicketToken,
  getRandomBytes,
  toBase64,
  toBase64Url,
} from "#shared/crypto/utils.ts";

const withRandomBytes = <T>(bytes: number[], body: () => T): T => {
  const randomStub = stub(
    crypto,
    "getRandomValues",
    <A extends ArrayBufferView | null>(array: A): A => {
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.length; i++) array[i] = bytes[i] ?? 0;
      }
      return array;
    },
  );
  try {
    return body();
  } finally {
    randomStub.restore();
  }
};

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

describe("encoding helpers", () => {
  it("converts bytes to standard base64 and back", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = toBase64(bytes);
    expect(encoded).toBe("AAEC/f7/");
    expect(fromBase64(encoded)).toEqual(bytes);
  });

  it("converts standard base64 to unpadded base64url", () => {
    expect(base64ToBase64Url("AAEC/f7/")).toBe("AAEC_f7_");
    expect(base64ToBase64Url("+/8=")).toBe("-_8");
  });

  it("converts bytes to base64url and back", () => {
    const bytes = new Uint8Array([251, 255, 0, 16]);
    const encoded = toBase64Url(bytes);
    expect(encoded).toBe("-_8AEA");
    expect(encoded).not.toContain("=");
    expect(fromBase64Url(encoded)).toEqual(bytes);
  });
});

describe("getRandomBytes", () => {
  it("fills a Uint8Array of the requested length with Web Crypto bytes", () =>
    withRandomBytes([1, 2, 3, 4], () => {
      expect(getRandomBytes(4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    }));

  it("returns an empty Uint8Array for length zero", () => {
    expect(getRandomBytes(0)).toEqual(new Uint8Array());
  });
});

describe("generateSecureToken", () => {
  it("returns a 32-byte base64url encoded string without padding", () => {
    const token = generateSecureToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSecureToken());
    }
    // All 100 tokens should be unique
    expect(tokens.size).toBe(100);
  });

  it("encodes exactly the bytes returned by Web Crypto", () =>
    withRandomBytes(
      Array.from({ length: 32 }, (_, i) => i),
      () => {
        expect(generateSecureToken()).toBe(
          "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        );
      },
    ));
});

describe("generateTicketToken", () => {
  it("returns an uppercase hex string of 10 characters", () => {
    // 5 bytes = 10 hex characters
    const token = generateTicketToken();
    expect(token).toMatch(/^[0-9A-F]+$/);
    expect(token.length).toBe(10);
  });

  it("contains no dashes or underscores", () => {
    const token = generateTicketToken();
    expect(token).not.toContain("-");
    expect(token).not.toContain("_");
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateTicketToken());
    }
    expect(tokens.size).toBe(100);
  });

  it("encodes exactly five random bytes as uppercase hex", () =>
    withRandomBytes([0, 1, 10, 254, 255], () => {
      expect(generateTicketToken()).toBe("00010AFEFF");
    }));
});
