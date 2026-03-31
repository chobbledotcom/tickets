import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { readOnlyPage } from "#templates/public.tsx";
import { describeWithEnv, mockRequest } from "#test-utils";

/** Create a JSON API request */
const apiRequest = (
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Request => {
  const headers: Record<string, string> = { host: "localhost" };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
};

describeWithEnv(
  "read-only mode",
  { db: true, env: { READ_ONLY: "true" } },
  () => {
    test("GET /read-only returns the read-only page", async () => {
      const res = await handleRequest(mockRequest("/read-only"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Disabled: This site is in read-only mode.");
    });

    test("readOnlyPage contains the expected message", () => {
      const html = readOnlyPage();
      expect(html).toContain("Disabled: This site is in read-only mode.");
    });

    test("POST /api/admin/events returns 403 JSON", async () => {
      const res = await handleRequest(
        apiRequest("/api/admin/events", "POST", { name: "test" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(true);
      expect(body.message).toBe("This site is in read-only mode");
    });

    test("PUT /api/admin/events/1 returns 403 JSON", async () => {
      const res = await handleRequest(
        apiRequest("/api/admin/events/1", "PUT", { name: "test" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(true);
    });

    test("DELETE /api/admin/events/1 returns 403 JSON", async () => {
      const res = await handleRequest(
        apiRequest("/api/admin/events/1", "DELETE"),
      );
      expect(res.status).toBe(403);
    });

    test("POST /api/events/my-event/book returns 403 JSON", async () => {
      const res = await handleRequest(
        apiRequest("/api/events/my-event/book", "POST", { name: "test" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(true);
    });

    test("GET /api/admin/events is allowed", async () => {
      const res = await handleRequest(apiRequest("/api/admin/events"));
      // Should not be 403 — may be 401 (no auth) but not blocked by read-only
      expect(res.status).not.toBe(403);
    });

    test("GET /admin/event/new redirects to /read-only", async () => {
      const res = await handleRequest(mockRequest("/admin/event/new"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("GET /admin/event/42/edit redirects to /read-only", async () => {
      const res = await handleRequest(mockRequest("/admin/event/42/edit"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("GET /admin/event/42/duplicate redirects to /read-only", async () => {
      const res = await handleRequest(mockRequest("/admin/event/42/duplicate"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("GET /admin/groups/new redirects to /read-only", async () => {
      const res = await handleRequest(mockRequest("/admin/groups/new"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("GET /admin/groups/7/edit redirects to /read-only", async () => {
      const res = await handleRequest(mockRequest("/admin/groups/7/edit"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("POST /ticket/my-event redirects to /read-only", async () => {
      const res = await handleRequest(
        mockRequest("/ticket/my-event", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=test",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("POST /admin/event redirects to /read-only", async () => {
      const res = await handleRequest(
        mockRequest("/admin/event", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=test",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("POST /admin/groups redirects to /read-only", async () => {
      const res = await handleRequest(
        mockRequest("/admin/groups", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=test",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("POST /admin/event/42/attendee redirects to /read-only", async () => {
      const res = await handleRequest(
        mockRequest("/admin/event/42/attendee", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=test",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("GET / is not blocked by read-only guard", async () => {
      const res = await handleRequest(mockRequest("/"));
      // May redirect to /admin/login if public site is disabled, but not to /read-only
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    test("GET /events is not blocked by read-only guard", async () => {
      const res = await handleRequest(mockRequest("/events"));
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    test("GET /ticket/my-event is allowed (view form)", async () => {
      const res = await handleRequest(mockRequest("/ticket/my-event"));
      // 404 (no such event) is fine — not blocked by read-only
      expect(res.status).not.toBe(302);
    });

    test("POST /admin/login is not blocked (unrelated POST)", async () => {
      const res = await handleRequest(
        mockRequest("/admin/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "password=test",
        }),
      );
      expect(res.headers.get("location")).not.toBe("/read-only");
    });

    test("POST /admin/groups/5/add-events redirects to /read-only", async () => {
      const res = await handleRequest(
        mockRequest("/admin/groups/5/add-events", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "event_ids=1",
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/read-only");
    });

    test("POST /read-only returns 404", async () => {
      const res = await handleRequest(
        mockRequest("/read-only", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "test=1",
        }),
      );
      expect(res.status).toBe(404);
    });
  },
);
