import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { buildFlashCookie } from "#shared/cookies.ts";
import { getHeader } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { testCookie } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const deleteSetting = async (key: string): Promise<void> => {
  const { getDb } = await import("#db/client.ts");
  await getDb().execute({
    args: [key],
    sql: "DELETE FROM settings WHERE key = ?",
  });
  settings.invalidateCache();
};

/** A POST whose body stream dies mid-transfer, like a client that opens the
 * request and hangs up before the body arrives. */
const brokenBodyPost = (path: string): Request =>
  new Request(`http://localhost${path}`, {
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("connection dropped mid-body"));
      },
    }),
    duplex: "half",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "localhost",
    },
    method: "POST",
  } as RequestInit);

describeWithEnv("request pipeline", { db: true }, () => {
  const errors = setupErrorSpy();

  test("runs an ordinary page through routing and response security", async () => {
    await enablePublicSite();
    const response = await handleRequest(mockRequest("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("keeps ticket pages embeddable inside the request scopes", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const response = await handleRequest(
      mockRequest(`/ticket/${listing.slug}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("index, follow");
  });

  test("uses the configured payment provider in response security", async () => {
    await settings.update.paymentProvider("square");
    await settings.update.square.sandbox(true);
    const response = await handleRequest(mockRequest("/"));
    expect(response.headers.get("content-security-policy")).toContain(
      "https://connect.squareupsandbox.com",
    );
  });

  test("rejects a body-bearing POST with no content type", async () => {
    const request = new Request("http://localhost/admin/login", {
      body: new Uint8Array([1]),
      method: "POST",
    });
    expect(request.headers.get("content-type")).toBeNull();

    const response = await handleRequest(request);
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
    const { getDb } = await import("#db/client.ts");
    const { invalidateInitDbCache, SCHEMA_HASH } = await import(
      "#db/migrations.ts"
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

  /** A path nothing serves must die as a silent bare 404: no page, no report. */
  const expectBareSilent404 = async (path: string): Promise<void> => {
    const response = await handleRequest(brokenBodyPost(path));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(errors.calls.length).toBe(0);
  };

  test("answers a POST to a path nothing serves with a bare 404 and no error", async () => {
    await expectBareSilent404("/signin");
  });

  test("fast-404s a body-bearing POST to a GET-only static asset", async () => {
    await expectBareSilent404("/favicon.ico");
  });

  test("fast-404s a body-bearing POST to a GET-only page", async () => {
    await expectBareSilent404("/");
    await expectBareSilent404("/listings");
  });

  test("fast-404s a valid form POST to a GET-only page before any database work", async () => {
    const queries: string[] = [];
    const restore = recordQueries(queries);
    let response: Response;
    try {
      response = await handleRequest(mockFormRequest("/", { any: "field" }));
    } finally {
      restore();
    }
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(queries).toEqual([]);
  });

  test("still reports a body that dies on a route the app serves", async () => {
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
    const response = await handleRequest(brokenBodyPost("/payment/webhook"));

    expect(response.status).toBe(503);
    expect(errors.contains("E_CDN_REQUEST")).toBe(true);
  });

  test("keeps the styled 404 page for GET and HEAD probes", async () => {
    const get = await handleRequest(mockRequest("/signin"));
    expect(get.status).toBe(404);
    expect(await get.text()).toContain("Not Found");

    const head = await handleRequest(
      mockRequest("/signin", { method: "HEAD" }),
    );
    expect(head.status).toBe(404);
    expect(await head.text()).toContain("Not Found");
  });

  test("rethrows unexpected errors in test mode", async () => {
    const { getDb } = await import("#db/client.ts");
    const { invalidateListingsCache } = await import("#db/listings/records.ts");
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
      expect(errors.contains("E_CDN_REQUEST")).toBe(true);
    } finally {
      executeStub.restore();
    }
  });

  test("turns a busy database error into the retry page", async () => {
    const { DatabaseBusyError, getDb } = await import("#db/client.ts");
    const executeStub = stub(getDb(), "execute", () => {
      throw new DatabaseBusyError();
    });
    try {
      const response = await handleRequest(
        mockRequest("/ticket/anything", { method: "HEAD" }),
      );
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).toContain("The database is too busy.");
      expect(html).toContain('http-equiv="refresh"');
      expect(errors.contains("E_DB_BUSY")).toBe(true);
    } finally {
      executeStub.restore();
    }
  });

  test("clears an unusable session and sends the user to login", async () => {
    await deleteSetting(CONFIG_KEYS.WRAPPED_PRIVATE_KEY);
    const response = await handleRequest(
      mockRequest("/admin", { headers: { cookie: await testCookie() } }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    const cookie = getHeader(response, "set-cookie");
    expect(cookie).toContain("session=");
    expect(cookie).toContain("Max-Age=0");
  });

  test("redirects an unsupported setup request while setup is incomplete", async () => {
    await deleteSetting(CONFIG_KEYS.SETUP_COMPLETE);
    settings.setup.clearCache();

    const response = await handleRequest(
      mockRequest("/setup/", { method: "PUT" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
  });

  test("reads and clears a keyed flash cookie", async () => {
    const cookie = buildFlashCookie("notice", "Saved from cookie", true).split(
      ";",
    )[0]!;

    const response = await handleRequest(
      mockRequest("/admin/login?flash=notice", {
        headers: { cookie },
      }),
    );

    expect(await response.text()).toContain("Saved from cookie");
    expect(getHeader(response, "set-cookie")).toContain("flash_notice=;");
  });
});
