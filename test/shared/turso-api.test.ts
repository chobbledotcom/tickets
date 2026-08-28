import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Result } from "#shared/result.ts";
import {
  createTursoApi,
  tursoDbProvider as tursoApi,
} from "#shared/turso-api.ts";
import { testCreateDatabaseReturnsErrorOn403 } from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

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
  stubFetch((url, init) => {
    onRequest?.(url, init);
    if (url.includes("/databases") && !url.includes("/auth")) {
      return new Response(
        JSON.stringify({
          database: {
            DbId: dbId,
            Hostname: `${dbName}.turso.io`,
            Name: dbName,
          },
        }),
      );
    }
    if (url.includes("/auth/tokens")) {
      return new Response(JSON.stringify({ jwt }));
    }
    return new Response("unexpected", { status: 500 });
  });

/** Returns a `stubTursoFetch` `onRequest` callback that captures the create-database POST body into `out.body`. */
const captureCreateBody =
  (out: { body?: unknown }) => (url: string, init?: RequestInit) => {
    if (url.includes("/databases") && !url.includes("/auth")) {
      out.body = JSON.parse(init?.body as string);
    }
  };

/** A fetch stand-in whose database-create reply is a fixed platform row and
 * whose token reply is the raw `tokenBody`. */
const createReplyingWith =
  (database: Record<string, string>, tokenBody: string) =>
  (url: string): Response =>
    url.includes("/auth")
      ? new Response(tokenBody)
      : new Response(JSON.stringify({ database }));

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
          expect(result.value.dbUrl).toBe("libsql://my-site.turso.io");
          expect(result.value.dbToken).toBe("jwt_token");
          expect(result.value.dbId).toBe("db_test");
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
        stubTursoFetch("h", "db_h", "t", (_url, init) => {
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
        stubFetch(
          new Response(JSON.stringify({ error: "quota exceeded" }), {
            status: 422,
          }),
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
        stubFetch((url) => {
          if (url.includes("/databases") && !url.includes("/auth")) {
            return new Response(
              JSON.stringify({
                database: {
                  DbId: "db_tok_fail",
                  Hostname: "t.turso.io",
                  Name: "t",
                },
              }),
            );
          }

          return new Response(JSON.stringify({ message: "Unauthorized" }), {
            status: 401,
          });
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
          expect(result.value.dbUrl).toMatch(/^libsql:\/\//);
          expect(result.value.dbUrl).toContain("my-app.turso.io");
        }
      },
    );
  });

  test("createDatabase refuses a database host that is not a bare hostname", async () => {
    // A port in the returned hostname means the platform is not pointing at a
    // plain database host, so the schema must reject it.
    const jwt = JSON.stringify({ jwt: "j" });
    await withMocks(
      () =>
        stubFetch(
          createReplyingWith(
            { DbId: "db_port", Hostname: "db.example.com:8080", Name: "n" },
            jwt,
          ),
        ),
      async () => {
        const result = await tursoApi.createDatabase("Ported");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(
            "Create database returned an invalid response",
          );
        }
      },
    );
  });

  test("createDatabase names the token operation when its reply is not JSON", async () => {
    await withMocks(
      () =>
        stubFetch(
          createReplyingWith(
            { DbId: "d", Hostname: "t.turso.io", Name: "halfbroken" },
            "not json",
          ),
        ),
      async () => {
        const result = await tursoApi.createDatabase("HalfBroken");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(
            "Generate database token returned invalid JSON",
          );
        }
      },
    );
  });
});

/** Assert one databaseExists answer: a true/false value, or a refusal that
 * names the checking operation. */
const assertExistsAnswer = async (
  expected: boolean | "error",
  check: () => Promise<Result<boolean>>,
): Promise<void> => {
  const exists = await check();
  if (expected === "error") {
    expect(exists.ok).toBe(false);
    if (!exists.ok) {
      expect(exists.error).toContain("Check database");
    }
    return;
  }
  expect(exists.ok).toBe(true);
  if (exists.ok) {
    expect(exists.value).toBe(expected);
  }
};

describeWithEnv("turso api client", { env: TURSO_ENV }, () => {
  const client = () => createTursoApi("client-token");

  test("deleteDatabase DELETEs the slugged database at its org path", async () => {
    const seen: { init?: RequestInit | undefined; url?: string } = {};
    await withMocks(
      () =>
        stubFetch((url, init) => {
          seen.init = init;
          seen.url = url;
          return new Response(null, { status: 200 });
        }),
      async () => {
        const result = await client().deleteDatabase("myorg", "My Site!!");
        expect(result.ok).toBe(true);
        expect(seen.url).toBe(
          "https://api.turso.tech/v1/organizations/myorg/databases/my-site",
        );
        expect(seen.init?.method).toBe("DELETE");
      },
    );
  });

  test("deleteDatabase reports a failed delete", async () => {
    await withMocks(
      () => stubFetch(new Response("refused", { status: 500 })),
      async () => {
        const result = await client().deleteDatabase("myorg", "db");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Delete database");
        }
      },
    );
  });

  test("a delete stays runnable after its caller was interrupted, while an ordinary call carries the signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: { init?: RequestInit | undefined } = {};
    await withMocks(
      () =>
        stubFetch((url, init) => {
          seen.init = init;
          return url.endsWith("/organizations")
            ? new Response("[]")
            : new Response(null, { status: 200 });
        }),
      async () => {
        const interrupted = createTursoApi("tok", controller.signal);
        expect((await interrupted.deleteDatabase("o", "db")).ok).toBe(true);
        // Cleanup deletes ignore the signal, so none was handed to the fetch.
        expect(seen.init?.signal).toBeUndefined();

        await interrupted.listOrganizations();
        expect(seen.init?.signal).toBe(controller.signal);
      },
    );
  });

  test("databaseExists answers true, false on 404, and an error otherwise", async () => {
    const replies: {
      body: string;
      expected: boolean | "error";
      status?: number;
    }[] = [
      { body: "{}", expected: true },
      { body: "gone", expected: false, status: 404 },
      { body: "boom", expected: "error", status: 500 },
    ];
    for (const { body, expected, status = 200 } of replies) {
      await withMocks(
        () => stubFetch(() => new Response(body, { status })),
        () =>
          assertExistsAnswer(expected, () => client().databaseExists("o", "x")),
      );
    }
  });

  test("listGroups and listOrganizations name what Turso offered", async () => {
    await withMocks(
      () =>
        stubFetch((url) =>
          url.endsWith("/groups")
            ? new Response(
                JSON.stringify({
                  groups: [{ name: "default" }, { name: "edge" }],
                }),
              )
            : new Response("unexpected", { status: 500 }),
        ),
      async () => {
        const groups = await client().listGroups("myorg");
        expect(groups.ok).toBe(true);
        if (groups.ok) {
          expect(groups.value).toEqual(["default", "edge"]);
        }
      },
    );
    await withMocks(
      () =>
        stubFetch((url) =>
          url.endsWith("/organizations")
            ? new Response(
                JSON.stringify([{ slug: "personal" }, { slug: "work" }]),
              )
            : new Response("unexpected", { status: 500 }),
        ),
      async () => {
        const organizations = await client().listOrganizations();
        expect(organizations.ok).toBe(true);
        if (organizations.ok) {
          expect(organizations.value).toEqual(["personal", "work"]);
        }
      },
    );
  });

  test("createDatabase refuses a hostname the URL parser cannot read", async () => {
    // A hostname with a space cannot be parsed as a URL, so it cannot be a
    // database host even when the rest of the reply is well-formed.
    await withMocks(
      () =>
        stubFetch(
          createReplyingWith(
            { DbId: "db_space", Hostname: "Not A Hostname", Name: "host-test" },
            JSON.stringify({ jwt: "j" }),
          ),
        ),
      async () => {
        const result = await tursoApi.createDatabase("Host Test");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(
            "Create database returned an invalid response",
          );
        }
      },
    );
  });

  test("create posts to the databases collection and mints its token with POST", async () => {
    const seen: { method?: string | undefined; url?: string | undefined }[] =
      [];
    await withMocks(
      () =>
        stubFetch((url, init) => {
          seen.push({ method: init?.method, url });
          return url.includes("/auth")
            ? new Response(JSON.stringify({ jwt: "tok" }))
            : new Response(
                JSON.stringify({
                  database: {
                    DbId: "db_exact",
                    Hostname: "t.turso.io",
                    Name: "host-test",
                  },
                }),
              );
        }),
      async () => {
        const result = await client().createDatabase({
          group: "default",
          name: "Host Test",
          organization: "myorg",
        });
        expect(result.ok).toBe(true);
        expect(seen).toEqual([
          {
            method: "POST",
            url: "https://api.turso.tech/v1/organizations/myorg/databases",
          },
          {
            method: "POST",
            url: "https://api.turso.tech/v1/organizations/myorg/databases/host-test/auth/tokens?authorization=full-access",
          },
        ]);
      },
    );
  });

  test("a failing or malformed list names the operation that broke", async () => {
    await withMocks(
      () => stubFetch(() => new Response("refused", { status: 500 })),
      async () => {
        const groups = await client().listGroups("myorg");
        expect(groups.ok).toBe(false);
        if (!groups.ok) {
          expect(groups.error).toContain("List Turso groups");
        }
        const organizations = await client().listOrganizations();
        expect(organizations.ok).toBe(false);
        if (!organizations.ok) {
          expect(organizations.error).toContain("List Turso organizations");
        }
      },
    );
    await withMocks(
      () => stubFetch(() => new Response("not json")),
      async () => {
        await assertRejects(
          () => client().listGroups("myorg"),
          Error,
          "List Turso groups returned invalid JSON",
        );
        await assertRejects(
          () => client().listOrganizations(),
          Error,
          "List Turso organizations returned invalid JSON",
        );
      },
    );
  });
});
