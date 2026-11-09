/** The database key option on a built site's Secrets tab: which sites can
 *  rotate their key, and what the rotation route answers. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { findBuiltSiteByIdPrimary } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import {
  errorResult,
  type Outcome,
  okResult,
  type Result,
} from "#shared/result.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectErrorFlash } from "#test-utils/assertions/redirect.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const BUNNY_DB_URL = "libsql://managed-key.lite.bunnydb.net";

/** The Secrets tab's body for one site, with no secrets set yet. */
const secretsTabHtml = async (siteId: number): Promise<string> => {
  using _secrets = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
    Promise.resolve({ ok: true as const, secrets: [] }),
  );
  return await (await adminGet(`/admin/built-sites/${siteId}/secrets`)).text();
};

describeWithEnv(
  "built site database key option",
  {
    db: true,
    env: { BUNNY_API_KEY: "host-key", CAN_BUILD_SITES: "true" },
  },
  () => {
    test("offers the rotation for a database the host manages", async () => {
      const site = await createTestBuiltSite({
        dbToken: "old-key",
        dbUrl: BUNNY_DB_URL,
        hostingId: "8300",
        name: "Managed Key",
      });

      const html = await secretsTabHtml(site.id);

      expectIncludesAll(html, [
        "Database key",
        `action="/admin/built-sites/${site.id}/rotate-database-key"`,
        "Rotate database key",
        "Bunny",
      ]);
      // The key itself never reaches the page.
      assert(!html.includes("old-key"));
    });

    test("names the refusal for a local database instead of a button", async () => {
      const site = await createTestBuiltSite({
        dbUrl: "file:local.db",
        hostingId: "8301",
        name: "Local Key",
      });

      const html = await secretsTabHtml(site.id);

      expectIncludesAll(html, [
        "This site's database is a local file, so its key cannot be changed.",
      ]);
      assert(!html.includes("rotate-database-key"));
    });
  },
);

describeWithEnv(
  "built site database key route",
  {
    db: true,
    env: { BUNNY_API_KEY: "host-key", CAN_BUILD_SITES: "true" },
  },
  () => {
    const cases: {
      name: string;
      dbUrl: string;
      rotated: Result<string>;
      push: Outcome;
      /** The error the operator reads, or null when the rotation lands. */
      error: string | null;
      stored: string;
    }[] = [
      {
        dbUrl: BUNNY_DB_URL,
        error: null,
        name: "rotates the key, sends it to the site, and logs the change",
        push: { ok: true },
        rotated: okResult("new-key"),
        stored: "new-key",
      },
      {
        dbUrl: "file:local.db",
        error:
          "This site's database is a local file, so its key cannot be changed.",
        name: "refuses a database the host does not manage, and stores nothing",
        push: { ok: true },
        rotated: okResult("new-key"),
        stored: "old-key",
      },
      {
        dbUrl: BUNNY_DB_URL,
        error:
          "The database key changed, but the site did not receive it. Rotate the key again to retry. Set secret DB_TOKEN failed (500)",
        name: "tells the operator to rotate again when the push fails",
        push: errorResult("Set secret DB_TOKEN failed (500)"),
        rotated: okResult("new-key"),
        stored: "new-key",
      },
      {
        dbUrl: BUNNY_DB_URL,
        error: "Revoke database tokens failed (500)",
        name: "logs nothing when the provider refuses the rotation",
        push: { ok: true },
        rotated: errorResult("Revoke database tokens failed (500)"),
        stored: "old-key",
      },
    ];

    for (const { name, dbUrl, rotated, push, error, stored } of cases) {
      test(name, async () => {
        const site = await createTestBuiltSite({
          dbToken: "old-key",
          dbUrl,
          hostingId: "8400",
          name: "Key Route",
        });
        using _rotate = stub(bunnyDbProvider, "rotateDatabaseKey", () =>
          Promise.resolve(rotated),
        );
        using _push = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
          Promise.resolve(push),
        );

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-database-key`,
        );

        if (error === null) {
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/secrets`,
            "Database key rotated.",
          )(response);
        } else {
          expectErrorFlash(response, error);
        }
        expect((await findBuiltSiteByIdPrimary(site.id))!.dbToken).toBe(stored);
        const logs = await getAllActivityLog();
        expect(
          logs.filter((entry) => entry.message.startsWith("Rotated database")),
        ).toHaveLength(error === null ? 1 : 0);
      });
    }
  },
);
