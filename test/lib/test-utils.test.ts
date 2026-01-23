import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  awaitTestRequest,
  createTestDb,
  createTestDbWithSetup,
  mockFormRequest,
  mockRequest,
  randomString,
  resetDb,
  testRequest,
  wait,
} from "#test-utils";

describe("test-utils", () => {
  afterEach(() => {
    resetDb();
  });

  describe("createTestDb", () => {
    test("creates an in-memory database that can execute queries", async () => {
      await createTestDb();
      const { getDb } = await import("#lib/db/client");
      const result = await getDb().execute("SELECT 1 as test");
      expect(result.rows.length).toBe(1);
      expect(result.columns).toContain("test");
    });
  });

  describe("resetDb", () => {
    test("resets database so next getDb creates fresh connection", async () => {
      await createTestDb();
      const { getDb, setDb } = await import("#lib/db/client");
      const firstDb = getDb();
      resetDb();
      setDb(null);
      // After reset, we need to set up again to get a working db
      await createTestDb();
      const secondDb = getDb();
      expect(firstDb).not.toBe(secondDb);
    });
  });

  describe("mockRequest", () => {
    test("creates a GET request by default", () => {
      const request = mockRequest("/test");
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://localhost/test");
    });

    test("accepts custom options", () => {
      const request = mockRequest("/test", { method: "POST" });
      expect(request.method).toBe("POST");
    });
  });

  describe("mockFormRequest", () => {
    test("creates a POST request with form data", async () => {
      const request = mockFormRequest("/test", {
        name: "John",
        email: "john@example.com",
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );

      const body = await request.text();
      expect(body).toContain("name=John");
      expect(body).toContain("email=john%40example.com");
    });

    test("includes cookie when provided", () => {
      const request = mockFormRequest(
        "/test",
        { name: "John" },
        "__Host-session=abc123",
      );
      expect(request.headers.get("cookie")).toBe("__Host-session=abc123");
    });
  });

  describe("testRequest", () => {
    test("creates a GET request by default", () => {
      const request = testRequest("/test");
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://localhost/test");
      expect(request.headers.get("host")).toBe("localhost");
    });

    test("formats session token as cookie", () => {
      const request = testRequest("/admin/logout", "abc123");
      expect(request.headers.get("cookie")).toBe("__Host-session=abc123");
    });

    test("uses raw cookie string when provided", () => {
      const request = testRequest("/admin/", null, {
        cookie: "__Host-session=xyz; other=value",
      });
      expect(request.headers.get("cookie")).toBe(
        "__Host-session=xyz; other=value",
      );
    });

    test("token takes precedence over cookie", () => {
      const request = testRequest("/admin/", "token123", {
        cookie: "__Host-session=other",
      });
      expect(request.headers.get("cookie")).toBe("__Host-session=token123");
    });

    test("creates POST request with form data", async () => {
      const request = testRequest("/admin/login", null, {
        data: { username: "admin", password: "secret" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = await request.text();
      expect(body).toContain("username=admin");
      expect(body).toContain("password=secret");
    });

    test("combines token with form data", async () => {
      const request = testRequest("/admin/event/new", "mytoken", {
        data: { name: "Test Event" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("cookie")).toBe("__Host-session=mytoken");
      const body = await request.text();
      expect(body).toContain("name=Test+Event");
    });

    test("allows custom method override", () => {
      const request = testRequest("/admin/event/1", "token", {
        method: "DELETE",
      });
      expect(request.method).toBe("DELETE");
    });

    test("allows custom method with form data", async () => {
      const request = testRequest("/admin/event/1", null, {
        method: "PUT",
        data: { name: "Updated" },
      });
      expect(request.method).toBe("PUT");
      const body = await request.text();
      expect(body).toContain("name=Updated");
    });
  });

  describe("randomString", () => {
    test("generates string of specified length", () => {
      const str = randomString(10);
      expect(str.length).toBe(10);
    });

    test("generates alphanumeric string", () => {
      const str = randomString(100);
      expect(str).toMatch(/^[a-zA-Z0-9]+$/);
    });

    test("generates different strings each time", () => {
      const str1 = randomString(20);
      const str2 = randomString(20);
      expect(str1).not.toBe(str2);
    });
  });

  describe("wait", () => {
    test("waits for specified milliseconds", async () => {
      const start = Date.now();
      await wait(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe("awaitTestRequest", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("makes GET request and returns response", async () => {
      const response = await awaitTestRequest("/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Ticket");
    });

    test("accepts token as second argument", async () => {
      const response = await awaitTestRequest("/admin/", "nonexistent-token");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("accepts options object as second argument", async () => {
      const response = await awaitTestRequest("/health", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("accepts cookie in options", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: "session=fake",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });
});
