/** Direct tests for turso-api.ts — the replies the client refuses and the
 *  cleanup it runs when a created database turns out unusable. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createTursoApi } from "#shared/turso-api.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

const client = () => createTursoApi("direct-token");

const createRequest = {
  group: "default",
  name: "Direct Test",
  organization: "org",
};

const goodDatabase = {
  DbId: "db_direct",
  Hostname: "example.turso.io",
  Name: "direct-test",
};

const createReply = (database: Record<string, string>): Response =>
  new Response(JSON.stringify({ database }));

const deleteOk = (): Response => new Response(null, { status: 200 });

/** Run one create against scripted replies: it must fail, naming `part`. */
const expectCreateRefusal = async (
  name: string,
  part: string,
  first: FetchReply,
  ...rest: FetchReply[]
): Promise<void> =>
  await withMocks(
    () => stubFetch(first, ...rest),
    async () => {
      const result = await client().createDatabase(createRequest);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error).toContain(part);
    },
  );

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
