import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  bunnyDbProvider as bunnyDbApi,
  STORAGE_REGION,
} from "#shared/bunny-db.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** Bunny's live region config, as returned by GET /database/v1/config. */
const CONFIG_RESPONSE = {
  primary_regions: [{ id: "DE" }, { id: "UK" }, { id: "NY" }, { id: "SG" }],
  replica_regions: [{ id: "LA" }, { id: "SYD" }, { id: "BR" }, { id: "JH" }],
  storage_region_available: [{ id: "eu-west-1" }, { id: "us-east-1" }],
};

const PRIMARY_REGION_IDS = CONFIG_RESPONSE.primary_regions.map((r) => r.id);
const REPLICA_REGION_IDS = CONFIG_RESPONSE.replica_regions.map((r) => r.id);

/** A 200 response carrying Bunny's region config JSON. */
const configResponse = (): Response =>
  new Response(JSON.stringify(CONFIG_RESPONSE), { status: 200 });

interface DbDetail {
  name: string;
  token: string;
  url: string;
}

const DEFAULT_DETAIL: DbDetail = {
  name: "Test",
  token: "tok",
  url: "libsql://x.bunnydb.net",
};

/** Happy-path responses for the get-details and token steps of a create. */
const getAndAuthResponse = (
  url: string,
  dbId: string,
  detail: DbDetail = DEFAULT_DETAIL,
): Response =>
  url.includes(`/v2/databases/${dbId}`) && !url.includes("/auth")
    ? new Response(
        JSON.stringify({
          db: { db_id: dbId, name: detail.name, url: detail.url },
        }),
        { status: 200 },
      )
    : new Response(JSON.stringify({ token: detail.token }), { status: 200 });

/**
 * Stub fetch so the config endpoint returns Bunny's live regions and every
 * other URL is answered by `fallback`.
 */
const stubFetchAfterConfig = (fallback: (url: string) => Response) =>
  stub(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    return Promise.resolve(
      url.endsWith("/v1/config") ? configResponse() : fallback(url),
    );
  });

describeWithEnv("bunny-db", { env: { BUNNY_API_KEY: "test-api-key" } }, () => {
  const dbCreateFetch = (dbId: string, fallback: (url: string) => Response) =>
    stubFetchAfterConfig((url) =>
      url.endsWith("/v2/databases")
        ? new Response(JSON.stringify({ db_id: dbId }), { status: 200 })
        : fallback(url),
    );

  test("createDatabase calls create, get, and token endpoints", async () => {
    const fetchCalls: string[] = [];

    await withMocks(
      () =>
        stub(globalThis, "fetch", (input: string | URL | Request) => {
          const url = String(input);
          fetchCalls.push(url);

          if (url.endsWith("/v1/config")) {
            return Promise.resolve(configResponse());
          }

          if (url.endsWith("/v2/databases") && !url.includes("/auth")) {
            return Promise.resolve(
              new Response(JSON.stringify({ db_id: "db_test123" }), {
                status: 200,
              }),
            );
          }

          return Promise.resolve(
            getAndAuthResponse(url, "db_test123", {
              name: "My Site",
              token: "bny_token_abc",
              url: "libsql://my-site.lite.bunnydb.net",
            }),
          );
        }),
      async () => {
        const result = await bunnyDbApi.createDatabase("My Site");

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dbUrl).toBe("libsql://my-site.lite.bunnydb.net");
          expect(result.dbToken).toBe("bny_token_abc");
          expect(result.dbId).toBe("db_test123");
        }

        expect(fetchCalls.length).toBe(4);
        expect(fetchCalls[0]).toContain("/v1/config");
      },
    );
  });

  test("createDatabase sends every region Bunny reported as primaries and replicas", async () => {
    let createBody: unknown;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);

            if (url.endsWith("/v1/config")) {
              return Promise.resolve(configResponse());
            }

            if (url.endsWith("/v2/databases")) {
              createBody = JSON.parse(init?.body as string);
              return Promise.resolve(
                new Response(JSON.stringify({ db_id: "db_abc" }), {
                  status: 200,
                }),
              );
            }

            return Promise.resolve(getAndAuthResponse(url, "db_abc"));
          },
        ),
      async () => {
        await bunnyDbApi.createDatabase("Test");

        expect(createBody).toEqual({
          name: "Test",
          primary_regions: PRIMARY_REGION_IDS,
          replicas_regions: REPLICA_REGION_IDS,
          storage_region: STORAGE_REGION,
        });
      },
    );
  });

  test("createDatabase uses AccessKey header", async () => {
    const headers: string[] = [];

    const respondForHeaderTest = (url: string): Response => {
      if (url.endsWith("/v1/config")) {
        return configResponse();
      }
      if (url.endsWith("/v2/databases")) {
        return new Response(JSON.stringify({ db_id: "db_hdr" }), {
          status: 200,
        });
      }
      if (url.includes("/v2/databases/db_hdr") && !url.includes("/auth")) {
        return new Response(
          JSON.stringify({
            db: { db_id: "db_hdr", name: "H", url: "libsql://h.net" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/auth/generate")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      return new Response("", { status: 500 });
    };

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

            return Promise.resolve(respondForHeaderTest(url));
          },
        ),
      async () => {
        await bunnyDbApi.createDatabase("H");
        expect(headers.every((h) => h === "test-api-key")).toBe(true);
        expect(headers.length).toBeGreaterThan(0);
      },
    );
  });

  test("createDatabase returns error when the config endpoint fails", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response("Forbidden", { status: 403 })),
        ),
      async () => {
        const result = await bunnyDbApi.createDatabase("Bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Get database config failed (403)");
        }
      },
    );
  });

  test("createDatabase returns error when create endpoint fails", async () => {
    await withMocks(
      () =>
        stubFetchAfterConfig(() => new Response("Forbidden", { status: 403 })),
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
        dbCreateFetch(
          "db_err",
          () =>
            new Response(JSON.stringify({ Message: "Database not found" }), {
              status: 404,
            }),
        ),
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
        dbCreateFetch("db_tok", (url) => {
          if (url.includes("/v2/databases/db_tok") && !url.includes("/auth")) {
            return new Response(
              JSON.stringify({
                db: { db_id: "db_tok", name: "T", url: "libsql://t.net" },
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ code: 401 }), { status: 401 });
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
