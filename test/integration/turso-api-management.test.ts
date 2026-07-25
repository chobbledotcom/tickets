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
  const createTestDatabase = () =>
    api.createDatabase({
      group: "default",
      name: "database",
      organization: "personal",
    });

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
        expect(await new Response(requests[0]?.init?.body).json()).toEqual({
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
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer platform-token",
            );
            return new Response(
              JSON.stringify({
                organizations: [{ slug: "personal" }, { slug: "team" }],
              }),
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

  test("does not delete on a name mismatch from the create response", async () => {
    const urls: string[] = [];
    await withMocks(
      () =>
        stubFetch(new Response(databaseJson("other-name")), (url) => {
          urls.push(url);
          return new Response();
        }),
      async () => {
        expect(
          await api.createDatabase({
            group: "default",
            name: "requested-name",
            organization: "personal",
          }),
        ).toEqual({
          error: "Create database returned an unexpected name: other-name",
          ok: false,
        });
        expect(urls).toEqual([]);
      },
    );
  });

  test("rejects empty and malformed database response values", async () => {
    for (const database of [
      { DbId: "", Hostname: "database.turso.io", Name: "database" },
      { DbId: "id", Hostname: "not a hostname/", Name: "database" },
      { DbId: "id", Hostname: "database.turso.io:443", Name: "database" },
      { DbId: "id", Hostname: "database.turso.io", Name: "" },
    ]) {
      await withMocks(
        () =>
          stubFetch(new Response(JSON.stringify({ database })), new Response()),
        async () => {
          const result = await createTestDatabase();
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain(
              "Create database returned an invalid response",
            );
          }
        },
      );
    }
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

  test("deletes a newly created database when token parsing fails", async () => {
    const methods: (string | undefined)[] = [];
    await withMocks(
      () =>
        stubFetch(
          new Response(databaseJson("database")),
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
          new Response(databaseJson("database")),
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
          new Response(databaseJson("database")),
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

  const signalSentToFetch = async (
    action: () => Promise<unknown>,
  ): Promise<AbortSignal | null | undefined> => {
    let receivedSignal: AbortSignal | null | undefined;
    await withMocks(
      () =>
        stubFetch((_url, init) => {
          receivedSignal = init?.signal;
          return new Response(JSON.stringify({ organizations: [] }));
        }),
      async () => {
        await action();
      },
    );
    return receivedSignal;
  };

  test("forwards an abort signal to platform API requests", async () => {
    const controller = new AbortController();
    const signalApi = createTursoApi("platform-token", controller.signal);
    expect(await signalSentToFetch(() => signalApi.listOrganizations())).toBe(
      controller.signal,
    );
  });

  test("does not interrupt cleanup deletes with the abort signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("interrupted"));
    const signalApi = createTursoApi("platform-token", controller.signal);
    expect(
      await signalSentToFetch(() =>
        signalApi.deleteDatabase("personal", "database"),
      ),
    ).toBeUndefined();
  });

  test("does not delete when the create POST throws before a response", async () => {
    await withMocks(
      () =>
        stubFetch(() => {
          throw new Error("network dropped");
        }),
      async () => {
        const result = await createTestDatabase();
        expect(result).toEqual({
          error: "Create database failed: network dropped",
          ok: false,
        });
      },
    );
  });
});
