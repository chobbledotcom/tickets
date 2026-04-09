import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
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
        id: 1,
        created: "2024-01-15T10:30:00Z",
        event_id: 1,
        message: "Ticket reserved",
      },
      {
        id: 2,
        created: "2024-01-15T11:00:00Z",
        event_id: 1,
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
        id: 1,
        created: "2024-01-15T10:30:00Z",
        event_id: null,
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
        id: 1,
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        message: "Action",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, true, TEST_SESSION);
    expect(html).toContain("Showing the most recent 200 entries");
  });

  test("does not show truncation message when not truncated", () => {
    const entries = [
      {
        id: 1,
        created: "2024-01-15T10:30:00Z",
        event_id: null,
        message: "Action",
      },
    ];
    const html = adminGlobalActivityLogPage(entries, false, TEST_SESSION);
    expect(html).not.toContain("Showing the most recent 200 entries");
  });
});
