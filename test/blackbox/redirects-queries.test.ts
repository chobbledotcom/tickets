/**
 * The database requests that redirects add. The advanced settings page shows
 * the count from the settings, so it never reads the redirects table. A
 * missing page reads the table only when a redirect exists.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addRedirect,
  deleteRedirect,
  shopWith,
  visit,
} from "#test/blackbox/redirects.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  observeTransactions,
  wrapDbClient,
} from "#test-utils/record-queries.ts";

type Sent = { args: unknown[]; sql: string };

/** Every statement that `run` sends to the database, with its values. */
const sentBy = async (run: () => Promise<unknown>): Promise<Sent[]> => {
  const sent: Sent[] = [];
  const restore = wrapDbClient({
    batch: (statements) => {
      for (const { args, sql } of statements) sent.push({ args, sql });
    },
    execute: ({ args, sql }) => {
      sent.push({ args, sql });
      return null;
    },
  });
  const restoreTransactions = observeTransactions(({ args, sql }) => {
    sent.push({ args, sql });
  });
  try {
    await run();
  } finally {
    restoreTransactions();
    restore();
  }
  return sent;
};

/** The text of every statement that `run` sends to the database. */
const statementsOf = async (run: () => Promise<unknown>): Promise<string[]> =>
  (await sentBy(run)).map(({ sql }) => sql);

/** The statements of `run` that read or write the redirects table. */
const touchingRedirects = async (
  run: () => Promise<unknown>,
): Promise<string[]> =>
  (await statementsOf(run)).filter((text) => /\bredirects\b/.test(text));

const ADVANCED = "/admin/settings-advanced";

describeWithEnv("the database requests of redirects", { db: true }, () => {
  describe("the advanced settings page", () => {
    test("reads no redirect, and sends as many statements with five redirects as with none", async () => {
      const app = await shopWith();
      await app.get(ADVANCED);
      const none = await statementsOf(() => app.get(ADVANCED));
      for (const from of ["/a", "/b", "/c", "/d", "/e"]) {
        await addRedirect(app, from, "/z");
      }
      await app.get(ADVANCED);
      const five = await statementsOf(() => app.get(ADVANCED));
      expect(none.length).toBeGreaterThan(0);
      expect(five).toHaveLength(none.length);
      expect(await touchingRedirects(() => app.get(ADVANCED))).toEqual([]);
    });
  });

  describe("a missing page", () => {
    test("reads no redirect while none exists, and again after the last one is deleted", async () => {
      const app = await shopWith();
      await visit("/missing");
      const before = await touchingRedirects(() => visit("/missing"));
      await addRedirect(app, "/old", "/new");
      await deleteRedirect(app, "/old");
      await visit("/missing");
      const after = await touchingRedirects(() => visit("/missing"));
      expect([before, after]).toEqual([[], []]);
    });

    test("reads the table once by the blind index, and never the page in plain text", async () => {
      await shopWith(["/secret-old-page", "/secret-new-page"]);
      await visit("/missing");
      const reads = await touchingRedirects(() => visit("/missing"));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain("redirect.to_url");
      expect(reads[0]).toContain("from_index");
      expect(reads[0]).not.toContain("secret");
    });

    test("is not read for a request that cannot follow a redirect", async () => {
      await shopWith(["/old", "/new"]);
      await visit("/missing");
      expect([
        await touchingRedirects(() => visit("/old", "POST")),
        await touchingRedirects(() => visit("/admin/missing")),
      ]).toEqual([[], []]);
    });
  });

  describe("what an add writes", () => {
    test("holds no plain text, and sets the stored count after the row in the same transaction", async () => {
      const app = await shopWith();
      const sent = await sentBy(() =>
        addRedirect(app, "/secret-old", "https://example.com/secret-new"),
      );
      const inserts = sent.filter(({ sql }) =>
        /^INSERT INTO redirects\b/.test(sql.trim()),
      );
      expect(inserts).toHaveLength(1);
      const values = inserts[0]!.args.map(String);
      // The page and the new address are sealed, and the index differs.
      expect(values.join(" ")).not.toMatch(/secret|example/);
      expect(new Set(values).size).toBe(values.length);

      const countAt = sent.findIndex(
        ({ args, sql }) =>
          /INSERT OR REPLACE INTO settings/.test(sql) &&
          args.includes("redirect_count"),
      );
      expect(countAt).toBeGreaterThan(sent.indexOf(inserts[0]!));
    });
  });
});
