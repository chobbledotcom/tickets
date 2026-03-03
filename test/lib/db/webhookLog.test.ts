import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { logWebhookError, type WebhookLogEntry } from "#lib/db/webhookLog.ts";
import { queryAll } from "#lib/db/client.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("webhookLog", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("inserts a log entry with status code and event name", async () => {
    await logWebhookError(404, "Test Event");

    const rows = await queryAll<WebhookLogEntry>("SELECT * FROM webhook_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status_code).toBe(404);
    expect(rows[0]!.event_name).toBe("Test Event");
    expect(rows[0]!.created).toBeDefined();
  });

  test("stores multiple log entries", async () => {
    await logWebhookError(500, "Event A");
    await logWebhookError(502, "Event B");

    const rows = await queryAll<WebhookLogEntry>("SELECT * FROM webhook_log ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status_code).toBe(500);
    expect(rows[0]!.event_name).toBe("Event A");
    expect(rows[1]!.status_code).toBe(502);
    expect(rows[1]!.event_name).toBe("Event B");
  });

  test("stores comma-separated event names for multi-event webhooks", async () => {
    await logWebhookError(503, "Event A, Event B");

    const rows = await queryAll<WebhookLogEntry>("SELECT * FROM webhook_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_name).toBe("Event A, Event B");
  });
});
