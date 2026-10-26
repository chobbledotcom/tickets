// jscpd:ignore-start
import type { InStatement } from "@libsql/client";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { executeWithoutCacheInvalidation, getDb } from "#db/client.ts";
import { bumpSettingsVersion, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  assertPublicHtml,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

const footerTag = `<footer class="site-footer">`;

/** Record every statement the client runs, passing each through to the real
 * client. Restore the client before reading the list back. */
const withRecordedSql = async (
  run: () => Promise<unknown>,
): Promise<string[]> => {
  const db = getDb();
  const realExecute = db.execute.bind(db);
  const sqls: string[] = [];
  const executeStub = stub(db, "execute", (stmt: InStatement) => {
    sqls.push(typeof stmt === "string" ? stmt : stmt.sql);
    return realExecute(stmt);
  });
  try {
    await run();
  } finally {
    executeStub.restore();
  }
  return sqls;
};

describeWithEnv(
  "site footer images lookup",
  { db: true, triggers: true },
  () => {
    test("a page render runs the footer's images lookup through the recorder", async () => {
      await enablePublicSite();
      const image = await makeImage("FooterQuery");
      await settings.update.siteFooter(
        `Visit us.![FooterQuery](img#${image.id})`,
      );
      const sqls = await withRecordedSql(() => assertPublicHtml("/"));
      // The resolution tests in site-footer.test.ts prove the page consumed
      // the lookup. This one proves the recorder sees the images read that
      // the tests below exclude.
      expect(sqls.some((sql) => sql.includes("FROM images"))).toBe(true);
    });

    test("a warm render re-serves the cold lookup until a settings write", async () => {
      await enablePublicSite();
      const image = await makeImage("FooterMemo");
      const footerText = `Thanks for coming.![FooterMemo](img#${image.id})`;
      await settings.update.siteFooter(footerText);
      const footerRegionOf = (html: string): string =>
        html.slice(html.indexOf(footerTag), html.indexOf("</footer>"));

      let coldHtml = "";
      const coldSqls = await withRecordedSql(async () => {
        coldHtml = await assertPublicHtml("/");
      });
      expect(coldSqls.filter((sql) => sql.includes("FROM images")).length).toBe(
        1,
      );

      let warmHtml = "";
      const warmSqls = await withRecordedSql(async () => {
        warmHtml = await assertPublicHtml("/");
      });
      expect(warmSqls.some((sql) => sql.includes("FROM images"))).toBe(false);
      // The warm render serves the cold lookup's own table, so the footer is
      // byte-identical and the picture keeps its own address.
      expect(footerRegionOf(warmHtml)).toBe(footerRegionOf(coldHtml));
      assertStringIncludes(warmHtml, `<img src="/image/${image.filename}"`);

      // A settings write moves the version, so the next render re-queries.
      await settings.update.siteFooter(footerText);
      let rewrittenHtml = "";
      const rewrittenSqls = await withRecordedSql(async () => {
        rewrittenHtml = await assertPublicHtml("/");
      });
      expect(
        rewrittenSqls.filter((sql) => sql.includes("FROM images")).length,
      ).toBe(1);
      assertStringIncludes(
        rewrittenHtml,
        `<img src="/image/${image.filename}" alt="FooterMemo">`,
      );
    });

    test("a picture another isolate removes leaves the warm footer", async () => {
      await enablePublicSite();
      const image = await makeImage("FooterOtherIsolate");
      await settings.update.siteFooter(
        `Thanks for coming.![FooterOtherIsolate](img#${image.id})`,
      );

      const coldSqls = await withRecordedSql(async () => {
        await assertPublicHtml("/", `<img src="/image/${image.filename}"`);
      });
      expect(coldSqls.filter((sql) => sql.includes("FROM images")).length).toBe(
        1,
      );

      // The warm render re-serves the cold lookup, so it runs no images query.
      const warmSqls = await withRecordedSql(async () => {
        await assertPublicHtml("/");
      });
      expect(warmSqls.some((sql) => sql.includes("FROM images"))).toBe(false);

      // Another isolate commits the removal: the row leaves the images table
      // and the shared version moves there. This isolate's invalidation
      // callbacks never run, so the version is the only signal the cache reads.
      await executeWithoutCacheInvalidation(
        "DELETE FROM image_uses WHERE image_id = ?",
        [image.id],
      );
      await executeWithoutCacheInvalidation("DELETE FROM images WHERE id = ?", [
        image.id,
      ]);
      await bumpSettingsVersion();

      const afterSqls = await withRecordedSql(async () => {
        const html = await assertPublicHtml("/");
        assert(!html.includes(`<img src="/image/${image.filename}"`));
        assertStringIncludes(html, '<img src="" alt="FooterOtherIsolate">');
      });
      expect(
        afterSqls.filter((sql) => sql.includes("FROM images")).length,
      ).toBe(1);
    });

    test("requests that never render the footer run no images lookup", async () => {
      await enablePublicSite();
      await settings.update.orderEnabled(true);
      const image = await makeImage("FooterQuiet");
      await settings.update.siteFooter(`Note.![FooterQuiet](img#${image.id})`);
      const listing = await createTestListing({ name: "Quiet Item" });
      const sqls = await withRecordedSql(async () => {
        // A stylesheet, a JSON evaluation, and the gallery's redirect never
        // render a page, so none of them may pay the page's images read.
        expectStatus(200)(await handleRequest(mockRequest("/custom.css")));
        expectStatus(200)(
          await handleRequest(
            mockRequest(`/order/availability?select_${listing.id}=1`),
          ),
        );
        expectRedirect(
          await handleRequest(mockRequest(`/order?select_${listing.id}=1`)),
          /^\/ticket\//,
        );
      });
      // The requests ran real reads, so an empty recording would prove nothing.
      expect(sqls.length).toBeGreaterThan(0);
      expect(sqls.some((sql) => sql.includes("FROM images"))).toBe(false);
    });
  },
);
