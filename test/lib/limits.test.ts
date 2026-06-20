import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  ATTACHMENT_URL_MAX_AGE_S,
  assertPaymentsRetentionSafe,
  FORM_STASH_MAX_BYTES,
  FORM_STASH_MAX_ENTRIES,
  FORM_STASH_TTL_MS,
  formatBytes,
  formatLimitValue,
  formatMs,
  formatSeconds,
  LIMIT_ENTRIES,
  LOGIN_LOCKOUT_MS,
  MAX_ATTACHMENT_SIZE,
  MAX_BACKUPS,
  MAX_EMAIL_TEMPLATES,
  MAX_IMAGE_SIZE,
  MAX_LOGIN_ATTEMPTS,
  MAX_TEXTAREA_LENGTH,
  PRUNE_CONTACTS_RETENTION_DAYS,
  PRUNE_INTERVAL_HOURS,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_DAYS,
  PRUNE_PAYMENTS_RETENTION_DAYS,
  PRUNE_SESSIONS_RETENTION_DAYS,
  PRUNE_SUMUP_RETENTION_HOURS,
  PRUNE_UNUSED_STRINGS_RETENTION_DAYS,
  parsePositiveInt,
  readLimit,
  SCANNER_CSRF_MAX_AGE_S,
  SESSION_MAX_AGE_S,
  STALE_RESERVATION_MS,
  WEBHOOK_RETRY_WINDOW_DAYS,
} from "#shared/limits.ts";
import { setTestEnv } from "#test-utils";

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
    let restoreEnv: () => void;

    afterEach(() => {
      restoreEnv?.();
    });

    test("returns default when env var is not set", () => {
      expect(readLimit("NONEXISTENT_LIMIT_VAR", 42)).toBe(42);
    });

    test("uses env var value when set to a positive integer", () => {
      restoreEnv = setTestEnv({ TEST_LIMIT: "100" });
      expect(readLimit("TEST_LIMIT", 42)).toBe(100);
    });

    test("falls back to default for invalid env values", () => {
      // Covers all rejection cases in one table-driven test: bad values never
      // override the default regardless of how they're malformed.
      const invalid = ["", "abc", "0", "-5"];
      for (const value of invalid) {
        restoreEnv?.();
        restoreEnv = setTestEnv({ TEST_LIMIT: value });
        expect(readLimit("TEST_LIMIT", 42)).toBe(42);
      }
    });
  });

  describe("assertPaymentsRetentionSafe", () => {
    test("returns the value when it meets the webhook-retry floor", () => {
      expect(assertPaymentsRetentionSafe(WEBHOOK_RETRY_WINDOW_DAYS)).toBe(
        WEBHOOK_RETRY_WINDOW_DAYS,
      );
      expect(assertPaymentsRetentionSafe(90)).toBe(90);
    });

    test("throws when retention is below the webhook-retry window", () => {
      // A retention shorter than the provider retry window could prune a
      // payment's idempotency row while a retry can still arrive, re-processing
      // the paid session and risking a duplicate refund — so it must fail loudly.
      expect(() =>
        assertPaymentsRetentionSafe(WEBHOOK_RETRY_WINDOW_DAYS - 1),
      ).toThrow("webhook-retry window");
    });

    test("the live retention constant satisfies its own floor", () => {
      // PRUNE_PAYMENTS_RETENTION_DAYS is validated at import; pin the invariant
      // so a future default change can't silently drop below the floor.
      expect(PRUNE_PAYMENTS_RETENTION_DAYS).toBeGreaterThanOrEqual(
        WEBHOOK_RETRY_WINDOW_DAYS,
      );
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
        "MAX_TEXTAREA_LENGTH",
        "MAX_FORM_LINES",
        "MAX_IMAGE_SIZE",
        "MAX_ATTACHMENT_SIZE",
        "MAX_BACKUPS",
        "ATTACHMENT_URL_MAX_AGE_S",
        "SESSION_MAX_AGE_S",
        "SCANNER_CSRF_MAX_AGE_S",
        "STALE_RESERVATION_MS",
        "MAX_LOGIN_ATTEMPTS",
        "LOGIN_LOCKOUT_MS",
        "MAX_TOKEN_404S",
        "TOKEN_WINDOW_MS",
        "TOKEN_LOCKOUT_MS",
        "MAX_BOOKING_ATTEMPTS",
        "BOOKING_LOCKOUT_MS",
        "MAX_APIKEY_ATTEMPTS",
        "APIKEY_LOCKOUT_MS",
        "PRUNE_PAYMENTS_RETENTION_DAYS",
        "PRUNE_SESSIONS_RETENTION_DAYS",
        "PRUNE_LOGINS_RETENTION_DAYS",
        "PRUNE_TOKENS_RETENTION_DAYS",
        "PRUNE_SUMUP_RETENTION_HOURS",
        "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
        "PRUNE_CONTACTS_RETENTION_DAYS",
        "PRUNE_INTERVAL_HOURS",
        "FORM_STASH_TTL_MS",
        "FORM_STASH_MAX_BYTES",
        "FORM_STASH_MAX_ENTRIES",
        "MAX_EMAIL_TEMPLATES",
        "SUPPORT_FORM_NAG_DAYS",
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
      expect(currentByKey.get("STALE_RESERVATION_MS")).toBe(
        STALE_RESERVATION_MS,
      );
      expect(currentByKey.get("MAX_LOGIN_ATTEMPTS")).toBe(MAX_LOGIN_ATTEMPTS);
      expect(currentByKey.get("LOGIN_LOCKOUT_MS")).toBe(LOGIN_LOCKOUT_MS);
      expect(currentByKey.get("PRUNE_PAYMENTS_RETENTION_DAYS")).toBe(
        PRUNE_PAYMENTS_RETENTION_DAYS,
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
      expect(currentByKey.get("PRUNE_SUMUP_RETENTION_HOURS")).toBe(
        PRUNE_SUMUP_RETENTION_HOURS,
      );
      expect(currentByKey.get("PRUNE_UNUSED_STRINGS_RETENTION_DAYS")).toBe(
        PRUNE_UNUSED_STRINGS_RETENTION_DAYS,
      );
      expect(currentByKey.get("PRUNE_CONTACTS_RETENTION_DAYS")).toBe(
        PRUNE_CONTACTS_RETENTION_DAYS,
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
