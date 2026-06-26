import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  bunnyDbProvider as bunnyDbApi,
  EUROPEAN_REGIONS,
  STORAGE_REGION,
} from "#shared/bunny-db.ts";
import { describeWithEnv, withMocks } from "#test-utils";

describeWithEnv("bunny-db", { env: { BUNNY_API_KEY: "test-api-key" } }, () => {
  test("createDatabase calls create, get, and token endpoints", async () => {
    const fetchCalls: string[] = [];

    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          fetchCalls.push(url);

          if (url.endsWith("/v2/databases") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(JSON.stringify({ db_id: "db_test123" }), {
                status: 200,
              }),
            );
          }

          if (
            url.includes("/v2/databases/db_test123") &&
            !url.includes("/auth")
          ) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  db: {
                    db_id: "db_test123",
                    name: "My Site",
                    url: "libsql://my-site.lite.bunnydb.net",
                  },
                }),
                { status: 200 },
              ),
            );
          }

          if (url.includes("/auth/generate")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ expires_at: null, token: "bny_token_abc" }),
                { status: 200 },
              ),
            );
          }

          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }),
      async () => {
        const result = await bunnyDbApi.createDatabase("My Site");

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dbUrl).toBe("libsql://my-site.lite.bunnydb.net");
          expect(result.dbToken).toBe("bny_token_abc");
          expect(result.dbId).toBe("db_test123");
        }

        expect(fetchCalls.length).toBe(3);
      },
    );
  });

  test("createDatabase sends EU storage region with all European primaries and replicas", async () => {
    let createBody: unknown;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);

            if (url.endsWith("/v2/databases")) {
              createBody = JSON.parse(init?.body as string);
              return Promise.resolve(
                new Response(JSON.stringify({ db_id: "db_abc" }), {
                  status: 200,
                }),
              );
            }

            if (
              url.includes("/v2/databases/db_abc") &&
              !url.includes("/auth")
            ) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    db: {
                      db_id: "db_abc",
                      name: "Test",
                      url: "libsql://x.bunnydb.net",
                    },
                  }),
                  { status: 200 },
                ),
              );
            }

            if (url.includes("/auth/generate")) {
              return Promise.resolve(
                new Response(JSON.stringify({ token: "tok" }), { status: 200 }),
              );
            }

            return Promise.resolve(new Response("unexpected", { status: 500 }));
          },
        ),
      async () => {
        await bunnyDbApi.createDatabase("Test");

        expect(createBody).toEqual({
          name: "Test",
          primary_regions: EUROPEAN_REGIONS,
          replicas_regions: EUROPEAN_REGIONS,
          storage_region: STORAGE_REGION,
        });
      },
    );
  });

  test("createDatabase uses AccessKey header", async () => {
    const headers: string[] = [];

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const accessKey = (init?.headers as Record<string, string>)
              ?.AccessKey;
            if (accessKey) headers.push(accessKey);

            if (url.endsWith("/v2/databases")) {
              return Promise.resolve(
                new Response(JSON.stringify({ db_id: "db_hdr" }), {
                  status: 200,
                }),
              );
            }
            if (
              url.includes("/v2/databases/db_hdr") &&
              !url.includes("/auth")
            ) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    db: { db_id: "db_hdr", name: "H", url: "libsql://h.net" },
                  }),
                  { status: 200 },
                ),
              );
            }
            if (url.includes("/auth/generate")) {
              return Promise.resolve(
                new Response(JSON.stringify({ token: "t" }), { status: 200 }),
              );
            }
            return Promise.resolve(new Response("", { status: 500 }));
          },
        ),
      async () => {
        await bunnyDbApi.createDatabase("H");
        expect(headers.every((h) => h === "test-api-key")).toBe(true);
        expect(headers.length).toBeGreaterThan(0);
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
        const result = await bunnyDbApi.createDatabase("Bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Create database failed (403)");
        }
      },
    );
  });

  test("createDatabase returns error when get database endpoint fails with JSON Message", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith("/v2/databases")) {
            return Promise.resolve(
              new Response(JSON.stringify({ db_id: "db_err" }), {
                status: 200,
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ Message: "Database not found" }), {
              status: 404,
            }),
          );
        }),
      async () => {
        const result = await bunnyDbApi.createDatabase("Err");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Get database failed (404)");
          expect(result.error).toContain("Database not found");
        }
      },
    );
  });

  test("createDatabase returns error when token generation fails with JSON body", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith("/v2/databases")) {
            return Promise.resolve(
              new Response(JSON.stringify({ db_id: "db_tok" }), {
                status: 200,
              }),
            );
          }
          if (url.includes("/v2/databases/db_tok") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  db: { db_id: "db_tok", name: "T", url: "libsql://t.net" },
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ code: 401 }), { status: 401 }),
          );
        }),
      async () => {
        const result = await bunnyDbApi.createDatabase("T");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(
            "Generate database token failed (401)",
          );
        }
      },
    );
  });
});
