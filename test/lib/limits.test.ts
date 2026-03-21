import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  ATTACHMENT_URL_MAX_AGE_S,
  formatBytes,
  LIMIT_ENTRIES,
  LOGIN_LOCKOUT_MS,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
  MAX_LOGIN_ATTEMPTS,
  readLimit,
  SESSION_MAX_AGE_S,
  STALE_RESERVATION_MS,
} from "#lib/limits.ts";
import { setTestEnv } from "#test-utils";

describe("limits", () => {
  describe("default values", () => {
    test("MAX_IMAGE_SIZE defaults to 256KB", () => {
      expect(MAX_IMAGE_SIZE).toBe(256 * 1024);
    });

    test("MAX_ATTACHMENT_SIZE defaults to 25MB", () => {
      expect(MAX_ATTACHMENT_SIZE).toBe(25 * 1024 * 1024);
    });

    test("ATTACHMENT_URL_MAX_AGE_S defaults to 1 hour", () => {
      expect(ATTACHMENT_URL_MAX_AGE_S).toBe(3600);
    });

    test("SESSION_MAX_AGE_S defaults to 24 hours", () => {
      expect(SESSION_MAX_AGE_S).toBe(86400);
    });

    test("STALE_RESERVATION_MS defaults to 5 minutes", () => {
      expect(STALE_RESERVATION_MS).toBe(5 * 60 * 1000);
    });

    test("MAX_LOGIN_ATTEMPTS defaults to 5", () => {
      expect(MAX_LOGIN_ATTEMPTS).toBe(5);
    });

    test("LOGIN_LOCKOUT_MS defaults to 15 minutes", () => {
      expect(LOGIN_LOCKOUT_MS).toBe(15 * 60 * 1000);
    });
  });

  describe("readLimit", () => {
    let restoreEnv: () => void;

    afterEach(() => {
      restoreEnv?.();
    });

    test("returns default when env var is not set", () => {
      expect(readLimit("NONEXISTENT_LIMIT_VAR", 42)).toBe(42);
    });

    test("returns env var value when set to valid positive integer", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "100" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(100);
    });

    test("returns default when env var is not a number", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "abc" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(42);
    });

    test("returns default when env var is zero", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "0" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(42);
    });

    test("returns default when env var is negative", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "-5" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(42);
    });

    test("returns default when env var is empty string", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(42);
    });

    test("parses integer from string with trailing text", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "100abc" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(100);
    });
  });

  describe("LIMIT_ENTRIES", () => {
    test("contains an entry for every exported limit", () => {
      const envKeys = LIMIT_ENTRIES.map((e) => e.envKey);
      expect(envKeys).toContain("MAX_IMAGE_SIZE");
      expect(envKeys).toContain("MAX_ATTACHMENT_SIZE");
      expect(envKeys).toContain("ATTACHMENT_URL_MAX_AGE_S");
      expect(envKeys).toContain("SESSION_MAX_AGE_S");
      expect(envKeys).toContain("STALE_RESERVATION_MS");
      expect(envKeys).toContain("MAX_LOGIN_ATTEMPTS");
      expect(envKeys).toContain("LOGIN_LOCKOUT_MS");
    });

    test("every entry has matching current and default when no env override", () => {
      for (const entry of LIMIT_ENTRIES) {
        expect(entry.current).toBe(entry.defaultValue);
      }
    });

    test("every entry has a non-empty label and unit", () => {
      for (const entry of LIMIT_ENTRIES) {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.unit.length).toBeGreaterThan(0);
      }
    });
  });

  describe("formatBytes", () => {
    test("formats bytes below 1KB", () => {
      expect(formatBytes(512)).toBe("512B");
    });

    test("formats kilobytes", () => {
      expect(formatBytes(256 * 1024)).toBe("256KB");
    });

    test("formats megabytes", () => {
      expect(formatBytes(25 * 1024 * 1024)).toBe("25MB");
    });

    test("rounds to nearest integer", () => {
      expect(formatBytes(1.5 * 1024 * 1024)).toBe("2MB");
      expect(formatBytes(1.4 * 1024)).toBe("1KB");
    });
  });
});
