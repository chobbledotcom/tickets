import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import { expectHtmlEscaped, rejectionMessage } from "#test-utils/assertions.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  emailTestSandbox,
  expectSendNoop,
  rejectedFetch,
} from "#test-utils/email.ts";
import { setTestEnv } from "#test-utils/env.ts";
import {
  generateTestListingName,
  resetTestSlugCounter,
} from "#test-utils/internal.ts";
import {
  expectFetchSilent,
  expectNtfyNotification,
  mockFormRequest,
  mockRequest,
  okResponse,
  randomString,
  stubNtfyFetch,
  testRequest,
  wait,
} from "#test-utils/mocks.ts";
import { createTrackedTestDbFile } from "#test-utils/temp-db-files.ts";
import {
  getSetupState,
  invalidateTestDbCache,
} from "#test-utils/test-state.ts";

describe("test-utils — stubs, caches & request mocks", () => {
  afterEach(() => {
    resetDb();
  });

  const expectFormPostWithBody = async (
    request: Request,
    ...bodyContains: string[]
  ): Promise<void> => {
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = await request.text();
    for (const expected of bodyContains) {
      expect(body).toContain(expected);
    }
  };

  describe("rejectionMessage", () => {
    test("returns the thrown error's message", async () => {
      const msg = await rejectionMessage(Promise.reject(new Error("kaboom")));
      expect(msg).toBe("kaboom");
    });

    test("returns empty string when the promise resolves", async () => {
      const msg = await rejectionMessage(Promise.resolve("ok"));
      expect(msg).toBe("");
    });
  });

  describe("expectHtmlEscaped", () => {
    test("passes when script tags are escaped", () => {
      expectHtmlEscaped("hello &lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });

  describe("expectSendNoop", () => {
    test("stubs fetch, asserts false return and zero calls", async () => {
      const sandbox = emailTestSandbox();
      await expectSendNoop(sandbox, () => Promise.resolve(false));
      sandbox.teardown();
    });
  });

  describe("rejectedFetch", () => {
    test("rejects with a descriptive error", async () => {
      await expect(rejectedFetch()).rejects.toThrow("should not be called");
    });
  });

  describe("expectFetchSilent", () => {
    test("stubs fetch and asserts zero calls when body does not fetch", async () => {
      await expectFetchSilent(() => Promise.resolve());
    });
  });

  describe("okResponse", () => {
    test("resolves with a 200 Response", async () => {
      const response = await okResponse();
      expect(response.status).toBe(200);
    });
  });

  describe("stubNtfyFetch", () => {
    test("stubs globalThis.fetch and sets NTFY_URL env", async () => {
      const { fetchStub, restore } = stubNtfyFetch();
      try {
        await globalThis.fetch("https://ntfy.sh/test-topic", {
          body: "hello",
          method: "POST",
        });
        expectNtfyNotification(fetchStub, "hello");
      } finally {
        fetchStub.restore();
        restore();
      }
    });
  });
  describe("internal caches", () => {
    test("start with no cached setup state", () => {
      invalidateTestDbCache();
      expect(getSetupState()).toBe(null);
    });
  });

  describe("createTestDb", () => {
    test("creates an in-memory database that can execute queries", async () => {
      await createTestDb();
      const { getDb } = await import("#shared/db/client.ts");
      const result = await getDb().execute("SELECT 1 as test");
      expect(result.rows.length).toBe(1);
      expect(result.columns).toContain("test");
    });
  });

  describe("resetDb", () => {
    test("leaves a non-file DB_URL alone (nothing on disk to remove)", async () => {
      const { setTestEnv } = await import("#test-utils/env.ts");
      const restore = setTestEnv({ DB_URL: ":memory:" });
      try {
        resetDb(); // must not try to close/unlink a file for :memory:
      } finally {
        restore();
      }
    });

    test("resets database so next createTestDb gives clean state", async () => {
      await createTestDb();
      const { getDb, insert } = await import("#shared/db/client.ts");
      // Insert data into the first DB
      await getDb().execute(
        insert("listings", {
          created: "2024-01-01",
          fields: "email",
          max_attendees: 10,
          slug: "old",
          slug_index: "old",
        }),
      );
      resetDb();
      // After reset, we need to set up again to get a working db
      await createTestDb();
      // Data from previous test should be gone
      const result = await getDb().execute("SELECT * FROM listings");
      expect(result.rows.length).toBe(0);
    });

    test("can be called after the active temp database was already removed", async () => {
      await createTestDb();
      resetDb();

      expect(() => resetDb()).not.toThrow();
    });

    test("removes the temp database even when closing the client throws", async () => {
      const path = await createTrackedTestDbFile(".db");
      const restoreEnv = setTestEnv({ DB_URL: `file:${path}` });
      const { setDb } = await import("#shared/db/client.ts");
      setDb({
        close: () => {
          throw new Error("already closed");
        },
      } as unknown as Client);
      let cleanupError: unknown;

      try {
        expect(() => resetDb()).not.toThrow();
        try {
          await Deno.stat(path);
          throw new Error("temp database still exists");
        } catch (error) {
          expect(error).toBeInstanceOf(Deno.errors.NotFound);
        }
      } finally {
        restoreEnv();
        try {
          await Deno.remove(path);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) cleanupError = error;
        }
      }
      if (cleanupError) throw cleanupError;
    });

    test("removes SQLite sidecar files for the active temp database", async () => {
      await createTestDb();
      const url = Deno.env.get("DB_URL");
      const path = url!.slice("file:".length);
      const sidecars = [`${path}-journal`, `${path}-shm`, `${path}-wal`];
      for (const sidecar of sidecars) {
        Deno.writeTextFileSync(sidecar, "left");
      }

      resetDb();

      for (const sidecar of sidecars) {
        await expect(Deno.stat(sidecar)).rejects.toThrow(Deno.errors.NotFound);
      }
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
        email: "john@example.com",
        name: "John",
      });
      await expectFormPostWithBody(
        request,
        "name=John",
        "email=john%40example.com",
      );
    });

    test("includes cookie when provided", () => {
      const request = mockFormRequest(
        "/test",
        { name: "John" },
        `${getSessionCookieName()}=abc123`,
      );
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=abc123`,
      );
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
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=abc123`,
      );
    });

    test("uses raw cookie string when provided", () => {
      const request = testRequest("/admin/", null, {
        cookie: `${getSessionCookieName()}=xyz; other=value`,
      });
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=xyz; other=value`,
      );
    });

    test("token takes precedence over cookie", () => {
      const request = testRequest("/admin/", "token123", {
        cookie: `${getSessionCookieName()}=other`,
      });
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=token123`,
      );
    });

    test("creates POST request with form data", async () => {
      const request = testRequest("/admin/login", null, {
        data: { password: "secret", username: "admin" },
      });
      await expectFormPostWithBody(
        request,
        "username=admin",
        "password=secret",
      );
    });

    test("combines token with form data", async () => {
      const request = testRequest("/admin/listing/new", "mytoken", {
        data: { name: "Test Listing" },
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("cookie")).toBe(
        `${getSessionCookieName()}=mytoken`,
      );
      const body = await request.text();
      expect(body).toContain("name=Test+Listing");
    });

    test("allows custom method override", () => {
      const request = testRequest("/admin/listing/1", "token", {
        method: "DELETE",
      });
      expect(request.method).toBe("DELETE");
    });

    test("allows custom method with form data", async () => {
      const request = testRequest("/admin/listing/1", null, {
        data: { name: "Updated" },
        method: "PUT",
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

  describe("generateTestListingName", () => {
    test("generates incrementing names", () => {
      resetTestSlugCounter();
      expect(generateTestListingName()).toBe("Test Listing 1");
      expect(generateTestListingName()).toBe("Test Listing 2");
      expect(generateTestListingName()).toBe("Test Listing 3");
    });

    test("resetTestSlugCounter resets counter to 0", () => {
      generateTestListingName(); // Trigger lazy init if needed
      resetTestSlugCounter();
      expect(generateTestListingName()).toBe("Test Listing 1");
    });
  });
});
