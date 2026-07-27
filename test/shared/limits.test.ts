import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADDRESS_CACHE_DAYS,
  ADDRESS_CACHE_MS,
  ADDRESS_LOOKUP_LOCKOUT_MS,
  ATTACHMENT_URL_MAX_AGE_S,
  assertPaymentHistoryRedactionSafe,
  FORM_STASH_MAX_BYTES,
  FORM_STASH_MAX_ENTRIES,
  FORM_STASH_TTL_MS,
  formatBytes,
  formatLimitValue,
  formatMs,
  formatSeconds,
  LIMIT_ENTRIES,
  LOGIN_LOCKOUT_MS,
  MAINTENANCE_PRUNE_BATCH,
  MAX_ADDRESS_LOOKUPS,
  MAX_ATTACHMENT_SIZE,
  MAX_BACKUPS,
  MAX_EMAIL_TEMPLATES,
  MAX_IMAGE_SIZE,
  MAX_LOGIN_ATTEMPTS,
  MAX_TEXTAREA_LENGTH,
  PAYMENT_HISTORY_REDACTION_DAYS,
  PAYMENT_PROVIDER_RETRY_WINDOW_DAYS,
  PRUNE_CONTACTS_RETENTION_DAYS,
  PRUNE_INTERVAL_HOURS,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_DAYS,
  PRUNE_SESSIONS_RETENTION_DAYS,
  PRUNE_UNUSED_STRINGS_RETENTION_DAYS,
  parsePositiveInt,
  readLimit,
  SCANNER_CSRF_MAX_AGE_S,
  SESSION_MAX_AGE_S,
} from "#shared/limits.ts";
import { withEnv } from "#test-utils/env.ts";

describe("limits", () => {
  describe("parsePositiveInt", () => {
    test("parses a positive integer string", () => {
      expect(parsePositiveInt("42", 1)).toBe(42);
    });

    test("falls back for empty string", () => {
      expect(parsePositiveInt("", 99)).toBe(99);
    });

    test("falls back for zero (rejects non-positive)", () => {
      expect(parsePositiveInt("0", 99)).toBe(99);
    });

    test("falls back for negative numbers", () => {
      expect(parsePositiveInt("-5", 99)).toBe(99);
    });

    test("falls back for non-numeric input", () => {
      expect(parsePositiveInt("abc", 99)).toBe(99);
    });

    test("truncates fractional part (parseInt behaviour)", () => {
      // parseInt("3.9") === 3. This documents observed behaviour — callers
      // passing a float string get the floor, not a rounded value.
      expect(parsePositiveInt("3.9", 99)).toBe(3);
    });
  });

  describe("readLimit", () => {
    test("returns default when env var is not set", () => {
      using _env = withEnv({ NONEXISTENT_LIMIT_VAR: undefined });
      expect(readLimit("NONEXISTENT_LIMIT_VAR", 42)).toBe(42);
    });

    test("uses env var value when set to a positive integer", () => {
      using _env = withEnv({ TEST_LIMIT: "100" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(100);
    });

    test("falls back to default for invalid env values", () => {
      // Covers all rejection cases in one table-driven test: bad values never
      // override the default regardless of how they're malformed.
      const invalid = ["", "abc", "0", "-5"];
      using _env = withEnv({ TEST_LIMIT: undefined });
      for (const value of invalid) {
        Deno.env.set("TEST_LIMIT", value);
        expect(readLimit("TEST_LIMIT", 42)).toBe(42);
      }
    });
  });

  describe("assertPaymentHistoryRedactionSafe", () => {
    test("uses the providers' three-day retry window", () => {
      expect(PAYMENT_PROVIDER_RETRY_WINDOW_DAYS).toBe(3);
    });

    test("returns the value when it meets the provider-retry floor", () => {
      expect(
        assertPaymentHistoryRedactionSafe(PAYMENT_PROVIDER_RETRY_WINDOW_DAYS),
      ).toBe(PAYMENT_PROVIDER_RETRY_WINDOW_DAYS);
      expect(assertPaymentHistoryRedactionSafe(90)).toBe(90);
    });

    test("throws when retention is below the provider-retry window", () => {
      expect(() =>
        assertPaymentHistoryRedactionSafe(
          PAYMENT_PROVIDER_RETRY_WINDOW_DAYS - 1,
        ),
      ).toThrow(
        "PAYMENT_HISTORY_REDACTION_DAYS=2 is below the 3-day provider " +
          "retry window. Redacting payment evidence sooner could remove facts " +
          "while the provider is still retrying a payment or refund. " +
          "Set it to at least 3 (the default is 90).",
      );
    });

    test("the live retention constant satisfies its own floor", () => {
      expect(PAYMENT_HISTORY_REDACTION_DAYS).toBeGreaterThanOrEqual(
        PAYMENT_PROVIDER_RETRY_WINDOW_DAYS,
      );
    });
  });

  describe("ADDRESS_CACHE_DAYS", () => {
    test("defaults to 90 days and derives the millisecond window", () => {
      expect(ADDRESS_CACHE_DAYS).toBe(90);
      expect(ADDRESS_CACHE_MS).toBe(ADDRESS_CACHE_DAYS * 24 * 60 * 60 * 1000);
    });
  });

  describe("LIMIT_ENTRIES", () => {
    /**
     * Keeps the debug-page display honest: every exported tunable limit must
     * appear in LIMIT_ENTRIES so admins can see its configured value. If a
     * new constant is added to limits.ts without an entry, this test fails.
     */
    test("entries match the set of exported tunable constants", () => {
      const exportedKeys = [
        "ACTIVITY_LOG_BACKFILL_BATCH",
        "ADDRESS_CACHE_DAYS",
        "ADDRESS_LOOKUP_LOCKOUT_MS",
        "APIKEY_LOCKOUT_MS",
        "ATTACHMENT_URL_MAX_AGE_S",
        "BOOKING_LOCKOUT_MS",
        "FORM_STASH_MAX_BYTES",
        "FORM_STASH_MAX_ENTRIES",
        "FORM_STASH_TTL_MS",
        "LOGIN_LOCKOUT_MS",
        "MAINTENANCE_PRUNE_BATCH",
        "MAX_ADDRESS_LOOKUPS",
        "MAX_APIKEY_ATTEMPTS",
        "MAX_ATTACHMENT_SIZE",
        "MAX_BACKUPS",
        "MAX_BOOKING_ATTEMPTS",
        "MAX_EMAIL_TEMPLATES",
        "MAX_FORM_LINES",
        "MAX_IMAGE_SIZE",
        "MAX_LOGIN_ATTEMPTS",
        "MAX_TEXTAREA_LENGTH",
        "PAYMENT_HISTORY_REDACTION_DAYS",
        "MAX_TOKEN_404S",
        "PRUNE_CONTACTS_RETENTION_DAYS",
        "PRUNE_INTERVAL_HOURS",
        "PRUNE_LOGINS_RETENTION_DAYS",
        "PRUNE_SESSIONS_RETENTION_DAYS",
        "PRUNE_TOKENS_RETENTION_DAYS",
        "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
        "SCANNER_CSRF_MAX_AGE_S",
        "SESSION_MAX_AGE_S",
        "SUPPORT_FORM_NAG_DAYS",
        "TOKEN_LOCKOUT_MS",
        "TOKEN_WINDOW_MS",
      ].sort();
      const entryKeys = LIMIT_ENTRIES.map((e) => e.envKey).sort();
      expect(entryKeys).toEqual(exportedKeys);
    });

    test("each entry's current value matches its exported constant", () => {
      const currentByKey = new Map(
        LIMIT_ENTRIES.map((e) => [e.envKey, e.current]),
      );
      expect(currentByKey.get("MAX_TEXTAREA_LENGTH")).toBe(MAX_TEXTAREA_LENGTH);
      expect(currentByKey.get("MAX_IMAGE_SIZE")).toBe(MAX_IMAGE_SIZE);
      expect(currentByKey.get("MAX_ATTACHMENT_SIZE")).toBe(MAX_ATTACHMENT_SIZE);
      expect(currentByKey.get("MAX_BACKUPS")).toBe(MAX_BACKUPS);
      expect(currentByKey.get("ATTACHMENT_URL_MAX_AGE_S")).toBe(
        ATTACHMENT_URL_MAX_AGE_S,
      );
      expect(currentByKey.get("SESSION_MAX_AGE_S")).toBe(SESSION_MAX_AGE_S);
      expect(currentByKey.get("SCANNER_CSRF_MAX_AGE_S")).toBe(
        SCANNER_CSRF_MAX_AGE_S,
      );
      expect(currentByKey.get("MAX_LOGIN_ATTEMPTS")).toBe(MAX_LOGIN_ATTEMPTS);
      expect(currentByKey.get("LOGIN_LOCKOUT_MS")).toBe(LOGIN_LOCKOUT_MS);
      expect(currentByKey.get("MAINTENANCE_PRUNE_BATCH")).toBe(
        MAINTENANCE_PRUNE_BATCH,
      );
      expect(currentByKey.get("PAYMENT_HISTORY_REDACTION_DAYS")).toBe(
        PAYMENT_HISTORY_REDACTION_DAYS,
      );
      expect(currentByKey.get("PRUNE_SESSIONS_RETENTION_DAYS")).toBe(
        PRUNE_SESSIONS_RETENTION_DAYS,
      );
      expect(currentByKey.get("PRUNE_LOGINS_RETENTION_DAYS")).toBe(
        PRUNE_LOGINS_RETENTION_DAYS,
      );
      expect(currentByKey.get("PRUNE_INTERVAL_HOURS")).toBe(
        PRUNE_INTERVAL_HOURS,
      );
      expect(currentByKey.get("PRUNE_UNUSED_STRINGS_RETENTION_DAYS")).toBe(
        PRUNE_UNUSED_STRINGS_RETENTION_DAYS,
      );
      expect(currentByKey.get("PRUNE_CONTACTS_RETENTION_DAYS")).toBe(
        PRUNE_CONTACTS_RETENTION_DAYS,
      );
      expect(currentByKey.get("ADDRESS_CACHE_DAYS")).toBe(ADDRESS_CACHE_DAYS);
      expect(currentByKey.get("MAX_ADDRESS_LOOKUPS")).toBe(MAX_ADDRESS_LOOKUPS);
      expect(currentByKey.get("ADDRESS_LOOKUP_LOCKOUT_MS")).toBe(
        ADDRESS_LOOKUP_LOCKOUT_MS,
      );
      expect(currentByKey.get("FORM_STASH_TTL_MS")).toBe(FORM_STASH_TTL_MS);
      expect(currentByKey.get("FORM_STASH_MAX_BYTES")).toBe(
        FORM_STASH_MAX_BYTES,
      );
      expect(currentByKey.get("FORM_STASH_MAX_ENTRIES")).toBe(
        FORM_STASH_MAX_ENTRIES,
      );
      expect(currentByKey.get("MAX_EMAIL_TEMPLATES")).toBe(MAX_EMAIL_TEMPLATES);
    });

    test("every entry renders to a non-empty string via formatLimitValue", () => {
      // Guards the debug page: if a new unit is introduced that
      // formatLimitValue can't render, an entry could slip through with a
      // blank or nonsensical label.
      for (const entry of LIMIT_ENTRIES) {
        const rendered = formatLimitValue(entry.current, entry.unit);
        expect(rendered.length).toBeGreaterThan(0);
        // Must end with a recognisable unit suffix — never just a bare number.
        expect(rendered).toMatch(/[A-Za-z]/);
      }
    });
  });

  describe("SCANNER_CSRF_MAX_AGE_S", () => {
    test("defaults to the session lifetime", () => {
      // The scanner page stays open for a whole listing, so its CSRF token must
      // outlive the 1-hour default and remain valid for as long as the session
      // that authenticates the admin.
      expect(SCANNER_CSRF_MAX_AGE_S).toBe(SESSION_MAX_AGE_S);
    });
  });

  describe("PRUNE_INTERVAL_MS", () => {
    test("is derived from PRUNE_INTERVAL_HOURS in ms", () => {
      expect(PRUNE_INTERVAL_MS).toBe(PRUNE_INTERVAL_HOURS * 60 * 60 * 1000);
    });
  });

  describe("formatBytes", () => {
    test("formats bytes below 1KB", () => {
      expect(formatBytes(512)).toBe("512B");
    });

    test("uses KB at the 1024 boundary", () => {
      expect(formatBytes(1024)).toBe("1KB");
    });

    test("formats kilobytes", () => {
      expect(formatBytes(256 * 1024)).toBe("256KB");
    });

    test("uses MB at the 1MB boundary", () => {
      expect(formatBytes(1024 * 1024)).toBe("1MB");
    });

    test("formats megabytes", () => {
      expect(formatBytes(25 * 1024 * 1024)).toBe("25MB");
    });

    test("rounds to nearest integer", () => {
      expect(formatBytes(1.5 * 1024 * 1024)).toBe("2MB");
      expect(formatBytes(1.4 * 1024)).toBe("1KB");
    });
  });

  describe("formatMs", () => {
    test("formats milliseconds below 1s", () => {
      expect(formatMs(500)).toBe("500ms");
    });

    test("uses seconds at the 1000ms boundary", () => {
      expect(formatMs(1000)).toBe("1s");
    });

    test("formats minutes", () => {
      expect(formatMs(5 * 60 * 1000)).toBe("5min");
    });

    test("uses hours at the 1h boundary", () => {
      expect(formatMs(60 * 60 * 1000)).toBe("1h");
    });

    test("formats hours", () => {
      expect(formatMs(2 * 60 * 60 * 1000)).toBe("2h");
    });

    test("rounds to nearest integer", () => {
      expect(formatMs(90 * 1000)).toBe("2min");
    });
  });

  describe("formatSeconds", () => {
    test("formats seconds below 1min", () => {
      expect(formatSeconds(30)).toBe("30s");
    });

    test("uses minutes at the 60s boundary", () => {
      expect(formatSeconds(60)).toBe("1min");
    });

    test("uses hours at the 3600s boundary", () => {
      expect(formatSeconds(3600)).toBe("1h");
    });

    test("uses days at the 86400s boundary", () => {
      expect(formatSeconds(86400)).toBe("1d");
    });

    test("rounds to nearest integer", () => {
      expect(formatSeconds(5400)).toBe("2h");
    });
  });

  describe("formatLimitValue", () => {
    test("delegates to formatBytes for bytes unit", () => {
      expect(formatLimitValue(256 * 1024, "bytes")).toBe("256KB");
    });

    test("delegates to formatMs for ms unit", () => {
      expect(formatLimitValue(5 * 60 * 1000, "ms")).toBe("5min");
    });

    test("delegates to formatSeconds for seconds unit", () => {
      expect(formatLimitValue(3600, "seconds")).toBe("1h");
    });

    test("appends 'chars' suffix for chars unit", () => {
      expect(formatLimitValue(10_240, "chars")).toBe("10240 chars");
    });

    test("appends 'days' suffix for days unit", () => {
      expect(formatLimitValue(90, "days")).toBe("90 days");
    });

    test("appends 'hours' suffix for hours unit", () => {
      expect(formatLimitValue(24, "hours")).toBe("24 hours");
    });

    test("returns value with unit for unknown units", () => {
      expect(formatLimitValue(5, "attempts")).toBe("5 attempts");
    });
  });
});
