import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  ADDRESS_CACHE_MS,
  LIMIT_ENTRIES,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
  positiveIntOrDefault,
} from "#shared/limits.ts";

const metadata = LIMIT_ENTRIES.map(({ defaultValue, envKey, label, unit }) => [
  envKey,
  defaultValue,
  label,
  unit,
]);

describe("limit registry contract", () => {
  test("keeps every public default, label, and unit exact", () => {
    expect(metadata).toEqual([
      ["MAX_IMAGE_SIZE", 33_554_432, "Max image size", "bytes"],
      ["MAX_ATTACHMENT_SIZE", 26_214_400, "Max attachment size", "bytes"],
      ["MAX_BACKUPS", 30, "Max retained backups", "backups"],
      ["MAX_TEXTAREA_LENGTH", 10_240, "Max textarea length", "chars"],
      ["MAX_FORM_LINES", 1000, "Max attendee-form line items", "lines"],
      ["ATTACHMENT_URL_MAX_AGE_S", 3600, "Attachment URL max age", "seconds"],
      ["SESSION_MAX_AGE_S", 86_400, "Session max age", "seconds"],
      ["SCANNER_CSRF_MAX_AGE_S", 86_400, "Scanner CSRF max age", "seconds"],
      ["STALE_RESERVATION_MS", 300_000, "Stale reservation threshold", "ms"],
      ["MAX_LOGIN_ATTEMPTS", 5, "Max login attempts", "attempts"],
      ["LOGIN_LOCKOUT_MS", 900_000, "Login lockout duration", "ms"],
      ["MAX_TOKEN_404S", 5, "Max token 404s before lockout", "attempts"],
      ["TOKEN_WINDOW_MS", 60_000, "Token 404 window", "ms"],
      ["TOKEN_LOCKOUT_MS", 300_000, "Token lockout duration", "ms"],
      [
        "MAX_BOOKING_ATTEMPTS",
        10,
        "Max booking attempts before lockout",
        "attempts",
      ],
      ["BOOKING_LOCKOUT_MS", 600_000, "Booking lockout duration", "ms"],
      [
        "MAX_ADDRESS_LOOKUPS",
        30,
        "Max address lookups before lockout",
        "attempts",
      ],
      [
        "ADDRESS_LOOKUP_LOCKOUT_MS",
        600_000,
        "Address lookup lockout duration",
        "ms",
      ],
      [
        "MAX_APIKEY_ATTEMPTS",
        20,
        "Max failed API-key attempts before lockout",
        "attempts",
      ],
      ["APIKEY_LOCKOUT_MS", 900_000, "API-key lockout duration", "ms"],
      [
        "PRUNE_PAYMENTS_RETENTION_DAYS",
        90,
        "Prune: payments retention",
        "days",
      ],
      [
        "PRUNE_SESSIONS_RETENTION_DAYS",
        90,
        "Prune: sessions retention",
        "days",
      ],
      [
        "PRUNE_LOGINS_RETENTION_DAYS",
        90,
        "Prune: login-attempts retention",
        "days",
      ],
      [
        "PRUNE_TOKENS_RETENTION_DAYS",
        7,
        "Prune: token-attempts retention",
        "days",
      ],
      [
        "PRUNE_SUMUP_RETENTION_HOURS",
        24,
        "Prune: SumUp checkout staging retention",
        "hours",
      ],
      [
        "SUMUP_FIRST_CHECK_HOURS",
        3,
        "SumUp recovery: first check after creation",
        "hours",
      ],
      [
        "SUMUP_RECHECK_HOURS",
        6,
        "SumUp recovery: wait before asking again",
        "hours",
      ],
      [
        "SUMUP_RECOVERY_INTERVAL_MINUTES",
        30,
        "SumUp recovery: how often to look for due checkouts",
        "minutes",
      ],
      [
        "SUMUP_RECOVERY_BATCH",
        3,
        "SumUp recovery: checkouts per run",
        "checkouts",
      ],
      [
        "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
        7,
        "Prune: unused encrypted strings retention",
        "days",
      ],
      [
        "PRUNE_CONTACTS_RETENTION_DAYS",
        1825,
        "Prune: contact-preferences retention",
        "days",
      ],
      ["ADDRESS_CACHE_DAYS", 90, "Address lookup cache retention", "days"],
      ["PRUNE_INTERVAL_HOURS", 24, "Prune: run interval", "hours"],
      ["MAINTENANCE_PRUNE_BATCH", 500, "Maintenance prune batch size", "rows"],
      [
        "ACTIVITY_LOG_BACKFILL_BATCH",
        200,
        "Activity-log backfill batch size",
        "rows",
      ],
      ["MAX_EMAIL_TEMPLATES", 1000, "Max saved email templates", "templates"],
      ["SUPPORT_FORM_NAG_DAYS", 7, "Support form repeat-submit notice", "days"],
      ["FORM_STASH_TTL_MS", 15_000, "Form re-fill stash TTL", "ms"],
      ["FORM_STASH_MAX_BYTES", 32_768, "Form re-fill stash max size", "bytes"],
      [
        "FORM_STASH_MAX_ENTRIES",
        100,
        "Form re-fill stash max entries",
        "entries",
      ],
    ]);
  });

  test("keeps derived maintenance windows exact", () => {
    expect({
      activityLogBackfill: ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
      addressCache: ADDRESS_CACHE_MS,
      contacts: PRUNE_CONTACTS_RETENTION_MS,
      logins: PRUNE_LOGINS_RETENTION_MS,
      payments: PRUNE_PAYMENTS_RETENTION_MS,
      sessions: PRUNE_SESSIONS_RETENTION_MS,
      strings: PRUNE_UNUSED_STRINGS_RETENTION_MS,
      sumup: PRUNE_SUMUP_RETENTION_MS,
      tokens: PRUNE_TOKENS_RETENTION_MS,
    }).toEqual({
      activityLogBackfill: 60_000,
      addressCache: 7_776_000_000,
      contacts: 157_680_000_000,
      logins: 7_776_000_000,
      payments: 7_776_000_000,
      sessions: 7_776_000_000,
      strings: 604_800_000,
      sumup: 86_400_000,
      tokens: 604_800_000,
    });
  });

  test("parses one but rejects hexadecimal notation", () => {
    expect(positiveIntOrDefault("1", 99)).toBe(1);
    expect(positiveIntOrDefault("0x10", 99)).toBe(99);
  });
});
