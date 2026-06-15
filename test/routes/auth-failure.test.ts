import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { authFailure } from "#routes/auth.ts";

describe("authFailure", () => {
  describe("html channel", () => {
    test("not-authenticated returns 302 redirect to /admin", () => {
      const res = authFailure("html", "not-authenticated");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin");
    });

    test("forbidden returns 403 with Forbidden body", async () => {
      const res = authFailure("html", "forbidden");
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    test("invalid-csrf returns 403 with Invalid CSRF token body", async () => {
      const res = authFailure("html", "invalid-csrf");
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Invalid CSRF token");
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    test("invalid-api-key returns 403 Forbidden for html channel", async () => {
      const res = authFailure("html", "invalid-api-key");
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
    });
  });

  describe("json channel", () => {
    test("not-authenticated returns 401 JSON error", async () => {
      const res = authFailure("json", "not-authenticated");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Not authenticated" });
    });

    test("forbidden returns 403 JSON error", async () => {
      const res = authFailure("json", "forbidden");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "Forbidden" });
    });

    test("invalid-csrf returns 403 JSON Forbidden", async () => {
      const res = authFailure("json", "invalid-csrf");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "Forbidden" });
    });

    test("invalid-api-key returns 401 JSON error", async () => {
      const res = authFailure("json", "invalid-api-key");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Invalid API key" });
    });
  });
});
