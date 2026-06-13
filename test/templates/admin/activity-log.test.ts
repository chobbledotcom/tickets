import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { ErrorCode, formatErrorMessage } from "#shared/logger.ts";
import {
  adminEventActivityLogPage,
  adminGlobalActivityLogPage,
} from "#templates/admin/activityLog.tsx";
import { setupTestEncryptionKey, testEventWithCount } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminEventActivityLogPage", () => {
  test("renders activity log entries", () => {
    const event = testEventWithCount();
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: 1,
        id: 1,
        message: "Ticket reserved",
      },
      {
        created: "2024-01-15T11:00:00Z",
        event_id: 1,
        id: 2,
        message: "Payment received",
      },
    ];
    const html = adminEventActivityLogPage(event, entries, TEST_SESSION);
    expect(html).toContain("Ticket reserved");
    expect(html).toContain("Payment received");
    expect(html).toContain("Log");
  });

  test("renders empty state when no entries", () => {
    const event = testEventWithCount();
    const html = adminEventActivityLogPage(event, [], TEST_SESSION);
    expect(html).toContain("No activity recorded yet");
  });
});

describe("adminGlobalActivityLogPage", () => {
  test("renders global activity log with entries", () => {
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        id: 1,
        message: "System started",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION);
    expect(html).toContain("System started");
    expect(html).toContain("Log");
  });

  test("renders empty state when no entries", () => {
    const html = adminGlobalActivityLogPage([], false, TEST_SESSION);
    expect(html).toContain("No activity recorded yet");
  });

  test("shows truncation message when truncated", () => {
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        id: 1,
        message: "Action",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, true, TEST_SESSION);
    expect(html).toContain("Showing the most recent 200 entries");
  });

  test("does not show truncation message when not truncated", () => {
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        id: 1,
        message: "Action",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION);
    expect(html).not.toContain("Showing the most recent 200 entries");
  });

  test("prefixes Square signature errors with a link to re-do settings", () => {
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        id: 1,
        message: formatErrorMessage({
          code: ErrorCode.SQUARE_SIGNATURE,
          detail: "mismatch",
        }),
      },
    ];
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION);
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
    expect(html).toContain("Click here to re-do your Square settings");
    // The original error message is still shown after the link
    expect(html).toContain("Square signature verification failed");
  });

  test("does not add the Square settings link to unrelated messages", () => {
    const entries = [
      {
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        id: 1,
        message: "Payment received",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION);
    expect(html).not.toContain("Click here to re-do your Square settings");
  });
});
