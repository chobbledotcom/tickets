import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  createTestApiKeyToken,
  describeWithEnv,
  getTestSession,
  requestAsApiKey,
  requestAsSession,
} from "#test-utils";
import { createTestEvent } from "#test-utils/db-helpers.ts";

describeWithEnv("admin API security", { db: true }, () => {
  describe("malformed JSON with API key auth", () => {
    test("POST /api/admin/events returns 400 for malformed JSON", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("PUT /api/admin/events/:id returns 400 for malformed JSON", async () => {
      const event = await createTestEvent();
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey(`/api/admin/events/${event.id}`, apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("malformed JSON on POST does not create an event", async () => {
      const apiKey = await createTestApiKeyToken();
      const before = await (
        await import("#shared/db/events.ts")
      ).getAllEvents();
      const beforeCount = before.length;

      await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      const after = await (await import("#shared/db/events.ts")).getAllEvents();
      expect(after.length).toBe(beforeCount);
    });

    test("malformed JSON on PUT does not mutate the event", async () => {
      const event = await createTestEvent({ name: "Original Name" });
      const apiKey = await createTestApiKeyToken();

      await handleRequest(
        requestAsApiKey(`/api/admin/events/${event.id}`, apiKey, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );

      const refreshed = await (
        await import("#shared/db/events.ts")
      ).getEventWithCount(event.id);
      expect(refreshed!.name).toBe("Original Name");
    });
  });

  describe("malformed JSON with cookie auth", () => {
    test("POST /api/admin/events returns 400 with valid CSRF token", async () => {
      const session = await getTestSession();
      const response = await handleRequest(
        requestAsSession("/api/admin/events", session, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("PUT /api/admin/events/:id returns 400 with valid CSRF token", async () => {
      const event = await createTestEvent();
      const session = await getTestSession();
      const response = await handleRequest(
        requestAsSession(`/api/admin/events/${event.id}`, session, {
          body: "{not valid json",
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("missing or wrong content-type for mutating requests", () => {
    test("POST /api/admin/events without content-type returns 400", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: JSON.stringify({ max_attendees: 10, name: "Test" }),
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("PUT /api/admin/events/:id without content-type returns 400", async () => {
      const event = await createTestEvent();
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey(`/api/admin/events/${event.id}`, apiKey, {
          body: JSON.stringify({ name: "Updated" }),
          method: "PUT",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("POST /api/admin/events with text/plain content-type returns 400", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: JSON.stringify({ max_attendees: 10, name: "Test" }),
          headers: { "content-type": "text/plain" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("body-bearing DELETE without content-type is rejected", async () => {
      const event = await createTestEvent();
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey(`/api/admin/events/${event.id}`, apiKey, {
          body: JSON.stringify({ confirm_identifier: event.name }),
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("treats uppercase Content-Type the same as lowercase (RFC 7231)", async () => {
      const apiKey = await createTestApiKeyToken();
      const body = JSON.stringify({ max_attendees: 10, name: "Case Test" });

      const lower = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body,
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      const upper = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body,
          headers: { "content-type": "APPLICATION/JSON" },
          method: "POST",
        }),
      );
      // RFC 7231: media types are case-insensitive. Both requests must produce
      // the same response — in particular the uppercase form must not be
      // rejected as a missing/wrong content-type.
      expect(upper.status).toBe(lower.status);
    });
  });

  describe("JSON body shape validation", () => {
    test("POST /api/admin/events returns 400 for JSON array body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: "[]",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("POST /api/admin/events returns 400 for JSON null body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: "null",
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("POST /api/admin/events returns 400 for JSON primitive body", async () => {
      const apiKey = await createTestApiKeyToken();
      const response = await handleRequest(
        requestAsApiKey("/api/admin/events", apiKey, {
          body: '"just a string"',
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
