import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { tursoApi } from "#shared/turso-api.ts";
import { describeWithEnv, withMocks } from "#test-utils";

const TURSO_ENV = {
  TURSO_API_TOKEN: "test-turso-token",
  TURSO_GROUP: "default",
  TURSO_ORGANIZATION: "myorg",
};

const successFetch = (dbName = "my-site") =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);

    if (url.includes("/databases") && !url.includes("/auth")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            database: {
              DbId: "db_turso123",
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
        new Response(JSON.stringify({ jwt: "jwt_abc123" }), { status: 200 }),
      );
    }

    return Promise.resolve(new Response("unexpected", { status: 500 }));
  });

describeWithEnv("turso-api", { env: TURSO_ENV }, () => {
  test("createDatabase calls create and token endpoints", async () => {
    const fetchCalls: string[] = [];

    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          fetchCalls.push(url);

          if (url.includes("/databases") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  database: {
                    DbId: "db_test",
                    Hostname: "my-site.turso.io",
                    Name: "my-site",
                  },
                }),
                { status: 200 },
              ),
            );
          }

          if (url.includes("/auth/tokens")) {
            return Promise.resolve(
              new Response(JSON.stringify({ jwt: "jwt_token" }), {
                status: 200,
              }),
            );
          }

          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }),
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
    let createBody: unknown;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);

            if (url.includes("/databases") && !url.includes("/auth")) {
              createBody = JSON.parse(init?.body as string);
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    database: {
                      DbId: "db_x",
                      Hostname: "x.turso.io",
                      Name: "x",
                    },
                  }),
                  { status: 200 },
                ),
              );
            }

            if (url.includes("/auth/tokens")) {
              return Promise.resolve(
                new Response(JSON.stringify({ jwt: "j" }), { status: 200 }),
              );
            }

            return Promise.resolve(new Response("unexpected", { status: 500 }));
          },
        ),
      async () => {
        await tursoApi.createDatabase("x");
        expect(createBody).toEqual({ group: "default", name: "x" });
      },
    );
  });

  test("createDatabase uses Bearer token auth header", async () => {
    const authHeaders: string[] = [];

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const auth = (init?.headers as Record<string, string>)
              ?.Authorization;
            if (auth) authHeaders.push(auth);

            if (url.includes("/databases") && !url.includes("/auth")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    database: {
                      DbId: "db_h",
                      Hostname: "h.turso.io",
                      Name: "h",
                    },
                  }),
                  { status: 200 },
                ),
              );
            }

            if (url.includes("/auth/tokens")) {
              return Promise.resolve(
                new Response(JSON.stringify({ jwt: "t" }), { status: 200 }),
              );
            }

            return Promise.resolve(new Response("unexpected", { status: 500 }));
          },
        ),
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
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          fetchedUrls.push(url);

          if (url.includes("/databases") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  database: {
                    DbId: "db_url",
                    Hostname: "url-db.turso.io",
                    Name: "url-db",
                  },
                }),
                { status: 200 },
              ),
            );
          }

          if (url.includes("/auth/tokens")) {
            return Promise.resolve(
              new Response(JSON.stringify({ jwt: "tok" }), { status: 200 }),
            );
          }

          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }),
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
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response("Forbidden", { status: 403 })),
        ),
      async () => {
        const result = await tursoApi.createDatabase("Bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Create database failed (403)");
        }
      },
    );
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
      () => successFetch("my-app"),
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
