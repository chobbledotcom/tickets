import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  slugifyForTurso,
  tursoDbProvider as tursoApi,
} from "#shared/turso-api.ts";
import { describeWithEnv, withMocks } from "#test-utils";
import { testCreateDatabaseReturnsErrorOn403 } from "#test-utils/builder-mocks.ts";

const TURSO_ENV = {
  TURSO_API_TOKEN: "test-turso-token",
  TURSO_GROUP: "default",
  TURSO_ORGANIZATION: "myorg",
};

/**
 * Stub fetch with standard Turso URL routing: /databases → db JSON, /auth/tokens → JWT.
 * Pass `onRequest` to capture URL/init for inspection. Returns on unmatched URLs with 500.
 */
const stubTursoFetch = (
  dbName: string,
  dbId: string,
  jwt: string,
  onRequest?: (url: string, init?: RequestInit) => void,
) =>
  stub(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      onRequest?.(url, init);
      if (url.includes("/databases") && !url.includes("/auth")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              database: {
                DbId: dbId,
                Hostname: `${dbName}.turso.io`,
                Name: dbName,
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/auth/tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify({ jwt }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    },
  );

test("slugifyForTurso lowercases and replaces non-slug chars with hyphens", () => {
  expect(slugifyForTurso("My Site")).toBe("my-site");
  expect(slugifyForTurso("Test_DB 123")).toBe("test-db-123");
});

test("slugifyForTurso collapses consecutive hyphens and trims leading/trailing", () => {
  expect(slugifyForTurso("--My--Site--")).toBe("my-site");
});

test("slugifyForTurso truncates to 63 characters", () => {
  expect(slugifyForTurso("a".repeat(100))).toBe("a".repeat(63));
});

test("slugifyForTurso does not produce trailing hyphen when truncation lands on separator", () => {
  const result = slugifyForTurso(`${"a".repeat(62)}-b`);
  expect(result.endsWith("-")).toBe(false);
  expect(result.length).toBeLessThanOrEqual(63);
});

test("slugifyForTurso returns db for names that reduce to empty", () => {
  expect(slugifyForTurso("---")).toBe("db");
});

/** Returns a `stubTursoFetch` `onRequest` callback that captures the create-database POST body into `out.body`. */
const captureCreateBody =
  (out: { body?: unknown }) => (url: string, init?: RequestInit) => {
    if (url.includes("/databases") && !url.includes("/auth")) {
      out.body = JSON.parse(init?.body as string);
    }
  };

describeWithEnv("turso-api", { env: TURSO_ENV }, () => {
  test("createDatabase calls create and token endpoints", async () => {
    const fetchCalls: string[] = [];

    await withMocks(
      () =>
        stubTursoFetch("my-site", "db_test", "jwt_token", (url) =>
          fetchCalls.push(url),
        ),
      async () => {
        const result = await tursoApi.createDatabase("My Site");

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dbUrl).toBe("libsql://my-site.turso.io");
          expect(result.dbToken).toBe("jwt_token");
          expect(result.dbId).toBe("db_test");
        }

        expect(fetchCalls.length).toBe(2);
      },
    );
  });

  test("createDatabase POSTs name and group to the create endpoint", async () => {
    const out: { body?: unknown } = {};
    await withMocks(
      () => stubTursoFetch("x", "db_x", "j", captureCreateBody(out)),
      async () => {
        await tursoApi.createDatabase("x");
        expect(out.body).toEqual({ group: "default", name: "x" });
      },
    );
  });

  test("createDatabase slugifies the name before sending to Turso API", async () => {
    const slug: { body?: unknown } = {};
    await withMocks(
      () => stubTursoFetch("my-site", "db_slug", "j", captureCreateBody(slug)),
      async () => {
        await tursoApi.createDatabase("My Site");
        expect(slug.body).toEqual({ group: "default", name: "my-site" });
      },
    );
  });

  test("createDatabase uses Bearer token auth header", async () => {
    const authHeaders: string[] = [];

    await withMocks(
      () =>
        stubTursoFetch("h", "db_h", "t", (url, init) => {
          const auth = (init?.headers as Record<string, string>)?.Authorization;
          if (auth) authHeaders.push(auth);
        }),
      async () => {
        await tursoApi.createDatabase("h");
        expect(authHeaders.every((h) => h === "Bearer test-turso-token")).toBe(
          true,
        );
        expect(authHeaders.length).toBeGreaterThan(0);
      },
    );
  });

  test("createDatabase uses org and db name in URLs", async () => {
    const fetchedUrls: string[] = [];

    await withMocks(
      () =>
        stubTursoFetch("url-db", "db_url", "tok", (url) =>
          fetchedUrls.push(url),
        ),
      async () => {
        await tursoApi.createDatabase("url-db");
        expect(fetchedUrls.some((u) => u.includes("/myorg/"))).toBe(true);
        expect(fetchedUrls.some((u) => u.includes("/url-db/"))).toBe(true);
        expect(
          fetchedUrls.some((u) => u.includes("authorization=full-access")),
        ).toBe(true);
      },
    );
  });

  test("createDatabase returns error when create endpoint fails", async () => {
    await testCreateDatabaseReturnsErrorOn403(tursoApi);
  });

  test("createDatabase returns error when create endpoint fails with JSON error", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "quota exceeded" }), {
              status: 422,
            }),
          ),
        ),
      async () => {
        const result = await tursoApi.createDatabase("Bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Create database failed (422)");
          expect(result.error).toContain("quota exceeded");
        }
      },
    );
  });

  test("createDatabase returns error when token endpoint fails", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);

          if (url.includes("/databases") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  database: {
                    DbId: "db_tok_fail",
                    Hostname: "t.turso.io",
                    Name: "t",
                  },
                }),
                { status: 200 },
              ),
            );
          }

          return Promise.resolve(
            new Response(JSON.stringify({ message: "Unauthorized" }), {
              status: 401,
            }),
          );
        }),
      async () => {
        const result = await tursoApi.createDatabase("t");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(
            "Generate database token failed (401)",
          );
          expect(result.error).toContain("Unauthorized");
        }
      },
    );
  });

  test("createDatabase constructs libsql:// URL from hostname", async () => {
    await withMocks(
      () => stubTursoFetch("my-app", "db_turso123", "jwt_abc123"),
      async () => {
        const result = await tursoApi.createDatabase("My App");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dbUrl).toMatch(/^libsql:\/\//);
          expect(result.dbUrl).toContain("my-app.turso.io");
        }
      },
    );
  });
});
