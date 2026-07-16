import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { getHeader } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  mockFormRequest,
  mockRequest,
  withExpectedError,
} from "#test-utils/mocks.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { testCookie } from "#test-utils/session.ts";

const clearWrappedPrivateKey = async (): Promise<void> => {
  const { getDb } = await import("#shared/db/client.ts");
  await getDb().execute(
    "DELETE FROM settings WHERE key = 'wrapped_private_key'",
  );
  settings.invalidateCache();
};

describeWithEnv("request pipeline", { db: true }, () => {
  test("rejects a body-bearing POST with no content type", async () => {
    const response = await handleRequest(
      new Request("http://localhost/admin/login", {
        body: "password=test",
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid Content-Type");
  });

  test("redirects a tracked GET before touching the database", async () => {
    const queries: string[] = [];
    const restore = recordQueries(queries);
    let response: Response;
    try {
      response = await handleRequest(
        mockRequest("/ticket/listing?keep=yes&utm_source=test"),
      );
    } finally {
      restore();
    }
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/ticket/listing?keep=yes");
    expect(queries).toEqual([]);
  });

  test("does not clean tracking parameters from a POST", async () => {
    const response = await handleRequest(
      mockFormRequest("/admin/login?utm_source=test", { password: "test" }),
    );
    expect(response.status).not.toBe(301);
  });

  test("serves the migration page while another request owns the lock", async () => {
    const { getDb } = await import("#shared/db/client.ts");
    const { invalidateInitDbCache, SCHEMA_HASH } = await import(
      "#shared/db/migrations.ts"
    );
    const db = getDb();
    try {
      await db.execute(
        "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
      );
      await db.execute({
        args: ["migration_lock", new Date().toISOString()],
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      });
      invalidateInitDbCache();

      const response = await handleRequest(mockRequest("/"));
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Update In Progress");
    } finally {
      await db.execute("DELETE FROM settings WHERE key = 'migration_lock'");
      await db.execute({
        args: [SCHEMA_HASH],
        sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
      });
      invalidateInitDbCache();
    }
  });

  test("rethrows unexpected errors in test mode", async () => {
    const { getDb } = await import("#shared/db/client.ts");
    const { invalidateListingsCache } = await import(
      "#shared/db/listings/records.ts"
    );
    invalidateListingsCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    using _env = withEnv({ TEST_EXPECT_ERROR: undefined });
    const executeStub = stub(getDb(), "execute", () => {
      throw new Error("synthetic db failure");
    });
    try {
      await expect(
        handleRequest(mockRequest("/ticket/nonexistent")),
      ).rejects.toThrow("synthetic db failure");
    } finally {
      executeStub.restore();
    }
  });

  test("turns a busy database error into the retry page", async () => {
    const { DatabaseBusyError, getDb } = await import("#shared/db/client.ts");
    const executeStub = stub(getDb(), "execute", () => {
      throw new DatabaseBusyError();
    });
    try {
      const response = await handleRequest(mockRequest("/ticket/anything"));
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).toContain("The database is too busy.");
      expect(html).toContain('http-equiv="refresh"');
    } finally {
      executeStub.restore();
    }
  });

  test("clears an unusable session and sends the user to login", async () => {
    await clearWrappedPrivateKey();
    await withExpectedError(async () => {
      const response = await handleRequest(
        mockRequest("/admin", { headers: { cookie: await testCookie() } }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      const cookie = getHeader(response, "set-cookie");
      expect(cookie).toContain("session=");
      expect(cookie).toContain("Max-Age=0");
    });
  });
});
