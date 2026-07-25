import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTursoApi } from "#shared/turso-api.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

const api = createTursoApi("platform-token");
const databaseJson = (name = "new-database") =>
  JSON.stringify({
    database: {
      DbId: "database-id",
      Hostname: `${name}.turso.io`,
      Name: name,
    },
  });

describe("Turso management API", () => {
  test("creates a database prepared for a binary upload", async () => {
    const requests: { init: RequestInit | undefined; url: string }[] = [];
    await withMocks(
      () =>
        stubFetch(
          (url, init) => {
            requests.push({ init, url });
            return new Response(databaseJson());
          },
          (url, init) => {
            requests.push({ init, url });
            return new Response(JSON.stringify({ jwt: "database-token" }));
          },
        ),
      async () => {
        const result = await api.createDatabase({
          group: "default",
          name: "New Database",
          organization: "my org",
          seed: "database_upload",
        });

        expect(result).toEqual({
          ok: true,
          value: {
            dbId: "database-id",
            dbToken: "database-token",
            dbUrl: "libsql://new-database.turso.io",
            name: "new-database",
          },
        });
        expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
          group: "default",
          name: "new-database",
          seed: { type: "database_upload" },
        });
        expect(requests[0]?.url).toBe(
          "https://api.turso.tech/v1/organizations/my%20org/databases",
        );
        expect(requests[0]?.init?.method).toBe("POST");
        expect(requests[1]?.url).toContain(
          "/new-database/auth/tokens?authorization=full-access",
        );
        expect(requests[1]?.init?.method).toBe("POST");
      },
    );
  });

  test("checks whether the destination database exists", async () => {
    for (const [status, expected] of [
      [200, true],
      [404, false],
    ] as const) {
      await withMocks(
        () => stubFetch(new Response("", { status })),
        async () => {
          expect(await api.databaseExists("my org", "My Database")).toEqual({
            ok: true,
            value: expected,
          });
        },
      );
    }
  });

  test("reports a failed destination database check", async () => {
    await withMocks(
      () =>
        stubFetch(
          new Response(JSON.stringify({ error: "not allowed" }), {
            status: 403,
          }),
        ),
      async () => {
        expect(await api.databaseExists("personal", "database")).toEqual({
          error: "Check database failed (403): not allowed",
          ok: false,
        });
      },
    );
  });

  test("lists organizations and groups", async () => {
    const urls: string[] = [];
    await withMocks(
      () =>
        stubFetch(
          (url, init) => {
            urls.push(url);
            expect(
              (init?.headers as Record<string, string>).Authorization,
            ).toBe("Bearer platform-token");
            return new Response(
              JSON.stringify([{ slug: "personal" }, { slug: "team" }]),
            );
          },
          (url) => {
            urls.push(url);
            return new Response(
              JSON.stringify({
                groups: [{ name: "default" }, { name: "europe" }],
              }),
            );
          },
        ),
      async () => {
        expect(await api.listOrganizations()).toEqual({
          ok: true,
          value: ["personal", "team"],
        });
        expect(await api.listGroups("my org")).toEqual({
          ok: true,
          value: ["default", "europe"],
        });
        expect(urls[0]).toBe("https://api.turso.tech/v1/organizations");
        expect(urls[1]).toContain("/organizations/my%20org/groups");
      },
    );
  });

  test("reports organization and group listing failures", async () => {
    for (const [run, label] of [
      [() => api.listOrganizations(), "List Turso organizations"],
      [() => api.listGroups("personal"), "List Turso groups"],
    ] as const) {
      await withMocks(
        () => stubFetch(new Response("unavailable", { status: 503 })),
        async () => {
          expect(await run()).toEqual({
            error: `${label} failed (503): unavailable`,
            ok: false,
          });
        },
      );
    }
  });

  test("rejects invalid JSON and invalid response shapes", async () => {
    await withMocks(
      () => stubFetch(new Response("not json")),
      async () => {
        await expect(api.listOrganizations()).rejects.toThrow(
          "List Turso organizations returned invalid JSON",
        );
      },
    );
    await withMocks(
      () => stubFetch(new Response(JSON.stringify({ groups: [{}] }))),
      async () => {
        await expect(api.listGroups("personal")).rejects.toThrow(
          "List Turso groups returned an invalid response",
        );
      },
    );
  });

  test("deletes a newly created database after an invalid create response", async () => {
    const methods: (string | undefined)[] = [];
    await withMocks(
      () =>
        stubFetch(new Response("not json"), (_url, init) => {
          methods.push(init?.method);
          return new Response();
        }),
      async () => {
        expect(
          await api.createDatabase({
            group: "default",
            name: "Database",
            organization: "personal",
          }),
        ).toEqual({
          error:
            "Create database failed: Create database returned invalid JSON",
          ok: false,
        });
        expect(methods).toEqual(["DELETE"]);
      },
    );
  });

  test("deletes a database", async () => {
    let request: { method: string | undefined; url: string | undefined } = {
      method: undefined,
      url: undefined,
    };
    await withMocks(
      () =>
        stubFetch((url, init) => {
          request = { method: init?.method, url };
          return new Response("{}");
        }),
      async () => {
        expect(await api.deleteDatabase("personal", "My Database")).toEqual({
          ok: true,
          value: undefined,
        });
        expect(request).toEqual({
          method: "DELETE",
          url: "https://api.turso.tech/v1/organizations/personal/databases/my-database",
        });
      },
    );
  });

  test("reports a database deletion failure", async () => {
    await withMocks(
      () => stubFetch(new Response("protected", { status: 409 })),
      async () => {
        expect(await api.deleteDatabase("personal", "database")).toEqual({
          error: "Delete database failed (409): protected",
          ok: false,
        });
      },
    );
  });

  test("uploads raw SQLite bytes to the database hostname", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await withMocks(
      () =>
        stubFetch(async (url, init) => {
          expect(url).toBe("https://database.turso.io/v1/upload");
          expect(init?.method).toBe("POST");
          expect(init?.headers).toEqual({
            Authorization: "Bearer database-token",
            "Content-Length": "4",
          });
          expect(
            new Uint8Array(await new Response(init?.body).arrayBuffer()),
          ).toEqual(bytes);
          return new Response();
        }),
      async () => {
        expect(
          await api.uploadDatabase(
            {
              dbId: "id",
              dbToken: "database-token",
              dbUrl: "libsql://database.turso.io",
            },
            bytes,
            bytes.byteLength,
          ),
        ).toEqual({ ok: true, value: undefined });
      },
    );
  });

  test("reports an upload failure", async () => {
    await withMocks(
      () => stubFetch(new Response("invalid sqlite", { status: 400 })),
      async () => {
        expect(
          await api.uploadDatabase(
            {
              dbId: "id",
              dbToken: "database-token",
              dbUrl: "libsql://database.turso.io",
            },
            new Uint8Array(),
            0,
          ),
        ).toEqual({
          error: "Upload database failed (400): invalid sqlite",
          ok: false,
        });
      },
    );
  });

  test("deletes a newly created database when token parsing fails", async () => {
    const methods: (string | undefined)[] = [];
    await withMocks(
      () =>
        stubFetch(
          new Response(databaseJson()),
          new Response(JSON.stringify({ token: "wrong field" })),
          (_url, init) => {
            methods.push(init?.method);
            return new Response();
          },
        ),
      async () => {
        const result = await api.createDatabase({
          group: "default",
          name: "database",
          organization: "personal",
        });
        expect(result).toEqual({
          error:
            "Generate database token failed: Generate database token returned an invalid response",
          ok: false,
        });
        expect(methods).toEqual(["DELETE"]);
      },
    );
  });

  test("reports token and cleanup failures together", async () => {
    await withMocks(
      () =>
        stubFetch(
          new Response(databaseJson()),
          new Response("denied", { status: 401 }),
          new Response("protected", { status: 409 }),
        ),
      async () => {
        const result = await api.createDatabase({
          group: "default",
          name: "database",
          organization: "personal",
        });
        expect(result).toEqual({
          error:
            "Generate database token failed (401): denied. Cleanup also failed: Delete database failed (409): protected",
          ok: false,
        });
      },
    );
  });

  test("reports a thrown cleanup failure", async () => {
    await withMocks(
      () =>
        stubFetch(
          new Response(databaseJson()),
          new Error("token network failed"),
          new Error("delete network failed"),
        ),
      async () => {
        const result = await api.createDatabase({
          group: "default",
          name: "database",
          organization: "personal",
        });
        expect(result).toEqual({
          error:
            "Generate database token failed: token network failed. Cleanup also failed: delete network failed",
          ok: false,
        });
      },
    );
  });
});
