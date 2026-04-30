import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAllActivityLog,
  getEventActivityLog,
  getEventWithActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("db > activity log", { db: true }, () => {
  test("logActivity creates log entry with message", async () => {
    const entry = await logActivity("Test action");

    expect(entry.id).toBe(1);
    expect(entry.message).toBe("Test action");
    expect(entry.event_id).toBeNull();
    expect(entry.created).toBeDefined();
  });

  test("logActivity creates log entry with event ID", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const entry = await logActivity("Created event 'Test Event'", event.id);

    expect(entry.event_id).toBe(event.id);
    expect(entry.message).toBe("Created event 'Test Event'");
  });

  test("getEventActivityLog returns entries for specific event", async () => {
    const event1 = await createTestEvent({
      maxAttendees: 50,
      name: "Event One",
      thankYouUrl: "https://example.com",
    });
    const event2 = await createTestEvent({
      maxAttendees: 50,
      name: "Event Two",
      thankYouUrl: "https://example.com",
    });

    await logActivity("Action for event 1", event1.id);
    await logActivity("Another action for event 1", event1.id);
    await logActivity("Action for event 2", event2.id);

    const event1Log = await getEventActivityLog(event1.id);
    // REST API also logs event creation, so we have 3 entries for event 1
    expect(event1Log.length).toBe(3);
    expect(event1Log[0]?.message).toBe("Another action for event 1");
    expect(event1Log[1]?.message).toBe("Action for event 1");
  });

  test("getEventActivityLog returns empty array when no entries", async () => {
    const entries = await getEventActivityLog(999);
    expect(entries).toEqual([]);
  });

  test("getEventActivityLog respects limit", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    await logActivity("Action 1", event.id);
    await logActivity("Action 2", event.id);
    await logActivity("Action 3", event.id);

    const entries = await getEventActivityLog(event.id, 2);
    expect(entries.length).toBe(2);
  });

  test("getAllActivityLog returns all entries", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      name: "Test Event",
      thankYouUrl: "https://example.com",
    });

    await logActivity("Global action");
    await logActivity("Event action", event.id);

    const entries = await getAllActivityLog();
    // REST API logs event creation, so we have 3 entries total
    expect(entries.length).toBe(3);
  });

  test("getAllActivityLog returns entries in descending order", async () => {
    await logActivity("First action");
    await logActivity("Second action");
    await logActivity("Third action");

    const entries = await getAllActivityLog();
    expect(entries[0]?.message).toBe("Third action");
    expect(entries[1]?.message).toBe("Second action");
    expect(entries[2]?.message).toBe("First action");
  });

  test("getAllActivityLog respects limit", async () => {
    await logActivity("Action 1");
    await logActivity("Action 2");
    await logActivity("Action 3");

    const entries = await getAllActivityLog(2);
    expect(entries.length).toBe(2);
  });

  test("getEventWithActivityLog returns event and activity log together", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      name: "Batch Test Event",
      thankYouUrl: "https://example.com",
    });

    await logActivity("First action", event.id);
    await logActivity("Second action", event.id);

    const result = await getEventWithActivityLog(event.id);
    expect(result).not.toBeNull();
    expect(result?.event.id).toBe(event.id);
    expect(result?.event.name).toBe("Batch Test Event");
    expect(result?.event.attendee_count).toBe(0);
    // REST API logs event creation + our 2 = 3
    expect(result?.entries.length).toBe(3);
    expect(result?.entries[0]?.message).toBe("Second action");
    expect(result?.entries[1]?.message).toBe("First action");
  });

  test("getEventWithActivityLog returns null for non-existent event", async () => {
    const result = await getEventWithActivityLog(999);
    expect(result).toBeNull();
  });
});
