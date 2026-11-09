/** Direct tests for turso-api.ts — the replies the client refuses and the
 *  cleanup it runs when a created database turns out unusable. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import { errorResult, okResult } from "#shared/result.ts";
import { createTursoApi, tursoDbProvider } from "#shared/turso-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type FetchReply,
  requestLines,
  stubFetch,
} from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

const client = () => createTursoApi("direct-token");

const createRequest = {
  group: "default",
  name: "Direct Test",
  organization: "org",
};

const DATABASE_URL =
  "https://api.turso.tech/v1/organizations/org/databases/direct-test";

const goodDatabase = {
  DbId: "db_direct",
  Hostname: "example.turso.io",
  Name: "direct-test",
};

const createReply = (database: Record<string, string>): Response =>
  new Response(JSON.stringify({ database }));

const deleteOk = (): Response => new Response(null, { status: 200 });

/** The fetch calls a stub took that asked the platform to remove a database. */
const deleteCalls = (fetchStub: Stub | undefined) =>
  (fetchStub?.calls ?? []).filter((call) => {
    const init = call.args[1];
    return (
      typeof init === "object" &&
      init !== null &&
      "method" in init &&
      init.method === "DELETE"
    );
  });

/** Run one create against scripted replies: it must fail, naming `part`. When
 * cleanup replies are scripted, exactly one removal DELETE must go out with
 * the expected URL; a single-reply refusal must issue none. */
const expectCreateRefusal = async (
  name: string,
  part: string,
  first: FetchReply,
  ...rest: FetchReply[]
): Promise<void> => {
  let fetchStub: Stub | undefined;
  await withMocks(
    () => (fetchStub = stubFetch(first, ...rest)),
    async () => {
      const result = await client().createDatabase(createRequest);
      expect(result.ok, name).toBe(false);
      if (!result.ok) assertStringIncludes(result.error, part);
      const deletes = deleteCalls(fetchStub);
      if (rest.length === 0) {
        expect(deletes, "the database must stay").toEqual([]);
      } else {
        expect(
          deletes.map((call) => call.args[0]),
          "the removal request",
        ).toEqual([DATABASE_URL]);
      }
    },
  );
};

describe("turso-api", () => {
  test("refuses a platform row with a blank id or name", async () => {
    for (const [blank, row] of [
      ["DbId", { ...goodDatabase, DbId: "" }],
      ["Name", { ...goodDatabase, Name: "" }],
    ] as const) {
      await expectCreateRefusal(
        blank,
        "Create database returned an invalid response",
        createReply(row),
        deleteOk(),
      );
    }
  });

  test("refuses a hostname that is not a bare host", async () => {
    await expectCreateRefusal(
      "slash host",
      "Create database returned an invalid response",
      createReply({ ...goodDatabase, Hostname: "example.turso.io/db" }),
      deleteOk(),
    );
  });

  test("refuses a token reply with a blank jwt", async () => {
    await expectCreateRefusal(
      "blank jwt",
      "Generate database token returned an invalid response",
      createReply(goodDatabase),
      new Response(JSON.stringify({ jwt: "" })),
      deleteOk(),
    );
  });

  test("names a platform row that answers with another database's name", async () => {
    await expectCreateRefusal(
      "renamed row",
      "Create database returned an unexpected name",
      createReply({ ...goodDatabase, Name: "other" }),
    );
  });

  test("reports when removing an unusable database fails", async () => {
    await expectCreateRefusal(
      "cleanup refused",
      "Create database returned an invalid response. " +
        "Cleanup also failed: Delete database failed (500): refused",
      createReply({ ...goodDatabase, DbId: "" }),
      new Response("refused", { status: 500 }),
    );
  });

  test("reports when removing an unusable database throws", async () => {
    await expectCreateRefusal(
      "cleanup threw",
      "Create database returned an invalid response. " +
        "Cleanup also failed: network down",
      createReply({ ...goodDatabase, DbId: "" }),
      new Error("network down"),
    );
  });

  test("seeds a new database from an upload when asked", async () => {
    const bodies: string[] = [];
    await withMocks(
      () =>
        stubFetch((url, init) => {
          if (!url.includes("/auth")) bodies.push(init?.body as string);
          return url.includes("/auth")
            ? new Response(JSON.stringify({ jwt: "direct-jwt" }))
            : createReply(goodDatabase);
        }),
      async () => {
        const result = await client().createDatabase({
          ...createRequest,
          seed: "database_upload",
        });
        expect(result.ok).toBe(true);
        expect(bodies).toEqual([
          JSON.stringify({
            group: "default",
            name: "direct-test",
            seed: { type: "database_upload" },
          }),
        ]);
      },
    );
  });
});

const ORG_DATABASES = "https://api.turso.tech/v1/organizations/org/databases";
const ROTATE_LINE = `POST ${DATABASE_URL}/auth/rotate`;
const TOKEN_LINE = `POST ${DATABASE_URL}/auth/tokens?authorization=full-access`;
const refused = (): Response => new Response("refused", { status: 500 });

/** Answer the database list with `databases`, then both key endpoints. */
const platformReply =
  (databases: unknown[]): FetchReply =>
  (url) => {
    if (url.endsWith("/databases")) return Response.json({ databases });
    return url.endsWith("/auth/rotate")
      ? deleteOk()
      : Response.json({ jwt: "fresh-token" });
  };

describeWithEnv(
  "turso-api database keys",
  { env: { TURSO_API_TOKEN: "platform-token", TURSO_ORGANIZATION: "org" } },
  () => {
    const cases: {
      name: string;
      reply: () => FetchReply;
      run: () => Promise<unknown>;
      result: unknown;
      requests: string[];
    }[] = [
      {
        name: "lists every database with the host it answers on",
        reply: () => platformReply([goodDatabase]),
        requests: [`GET ${ORG_DATABASES}`],
        result: okResult([{ host: "example.turso.io", id: "direct-test" }]),
        run: () => client().listDatabases("org"),
      },
      {
        name: "reports a refused database list",
        reply: refused,
        requests: [`GET ${ORG_DATABASES}`],
        result: errorResult("List Turso databases failed (500): refused"),
        run: () => client().listDatabases("org"),
      },
      {
        name: "invalidates every key before it makes the new one",
        reply: () => platformReply([]),
        requests: [ROTATE_LINE, TOKEN_LINE],
        result: okResult("fresh-token"),
        run: () => client().rotateDatabaseKey("org", "direct-test"),
      },
      {
        name: "stops before making a key when the invalidation is refused",
        reply: refused,
        requests: [ROTATE_LINE],
        result: errorResult("Rotate database key failed (500): refused"),
        run: () => client().rotateDatabaseKey("org", "direct-test"),
      },
      {
        name: "rotates the key of the database at the site's address",
        reply: () =>
          platformReply([
            { DbId: "db_1", Hostname: "other.turso.io", Name: "other" },
            goodDatabase,
          ]),
        requests: [`GET ${ORG_DATABASES}`, ROTATE_LINE, TOKEN_LINE],
        result: okResult("fresh-token"),
        run: () =>
          tursoDbProvider.rotateDatabaseKey("libsql://example.turso.io"),
      },
      {
        name: "refuses an address the organization does not list",
        reply: () => platformReply([goodDatabase]),
        requests: [`GET ${ORG_DATABASES}`],
        result: errorResult("No Turso database has the address gone.turso.io."),
        run: () => tursoDbProvider.rotateDatabaseKey("libsql://gone.turso.io"),
      },
    ];

    for (const { name, reply, run, result, requests } of cases) {
      test(name, async () => {
        using fetchStub = stubFetch(reply());

        expect(await run()).toEqual(result);
        expect(requestLines(fetchStub)).toEqual(requests);
      });
    }
  },
);
