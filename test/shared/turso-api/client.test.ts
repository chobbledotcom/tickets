import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Result } from "#shared/result.ts";
import { createTursoApi } from "#shared/turso-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { TEST_TURSO_ENV } from "./fixtures.ts";

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

describeWithEnv("turso api client", { env: TEST_TURSO_ENV }, () => {
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
