import { afterEach, describe, expect, test } from "bun:test";
import {
  createTestDb,
  mockFormRequest,
  mockRequest,
  randomString,
  resetDb,
  wait,
} from "#test-utils";

describe("test-utils", () => {
  afterEach(() => {
    resetDb();
  });

  describe("createTestDb", () => {
    test("creates an in-memory database that can execute queries", async () => {
      await createTestDb();
      const { getDb } = await import("#lib/db");
      const result = await getDb().execute("SELECT 1 as test");
      expect(result.rows.length).toBe(1);
      expect(result.columns).toContain("test");
    });
  });

  describe("resetDb", () => {
    test("resets database so next getDb creates fresh connection", async () => {
      await createTestDb();
      const { getDb, setDb } = await import("#lib/db");
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
        "session=abc123",
      );
      expect(request.headers.get("cookie")).toBe("session=abc123");
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
});
