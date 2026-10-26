import type { InStatement } from "@libsql/client";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { addPageImageUrls, imageUrlsFor } from "#db/image-urls.ts";
import { insertImageRecord } from "#db/images.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describeWithEnv(
  "server images > the image-url lookup",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    test("maps only the image ids the texts reference to their URL", async () => {
      const hero = await makeImage("Hero");
      await makeImage("Unreferenced");

      const urls = await imageUrlsFor([
        `![Poster](img#${hero.id})`,
        "no references here",
        null,
        undefined,
      ]);

      expect(urls.size).toBe(1);
      expect(urls.get(hero.id)).toBe(`/image/${hero.filename}`);
    });

    test("reads no images when the texts reference none", async () => {
      await makeImage("Hero");

      const urls = await imageUrlsFor(["plain text", null]);

      expect(urls.size).toBe(0);
    });

    test("drops an img#N reference whose id is not a safe positive integer", async () => {
      const hero = await makeImage("Hero");

      const urls = await imageUrlsFor([
        `![Huge](img#${"9".repeat(400)})`,
        "![Past the safe range](img#99999999999999999999)",
        `![Hero](img#${hero.id})`,
      ]);

      expect(urls.size).toBe(1);
      expect(urls.get(hero.id)).toBe(`/image/${hero.filename}`);
    });

    test("writes the referenced ids' URLs into the request's page table", async () => {
      const hero = await makeImage("Hero");
      await withRequestContext(async () => {
        await addPageImageUrls([`![Poster](img#${hero.id})`, "plain"]);

        assertStringIncludes(
          renderMarkdown(`![Poster](img#${hero.id})`),
          `src="/image/${hero.filename}"`,
        );
      });
    });

    test("writes nothing the texts do not reference", async () => {
      await makeImage("Hero");
      await withRequestContext(async () => {
        await addPageImageUrls(["plain text", null]);

        assertStringIncludes(
          renderMarkdown("![Poster](img#7)"),
          "<p>Poster</p>",
        );
        assert(!renderMarkdown("![Poster](img#7)").includes("<img"));
      });
    });

    test("writes nothing outside a request", async () => {
      const hero = await makeImage("Hero");

      await addPageImageUrls([`![Poster](img#${hero.id})`]);

      assertStringIncludes(
        renderMarkdown(`![Poster](img#${hero.id})`),
        "<p>Poster</p>",
      );
      assert(!renderMarkdown(`![Poster](img#${hero.id})`).includes("<img"));
    });
  },
);

describeWithEnv(
  "server images > the image-url cache",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    /** The image lookups the log records since the last enableQueryLog. */
    const imageLookups = () =>
      getQueryLog().filter((entry) => entry.sql.includes("FROM images")).length;

    /** The settings reads the log records since the last enableQueryLog. */
    const settingsReads = () =>
      getQueryLog().filter((entry) => entry.sql.includes("FROM settings"))
        .length;

    test("queries once cold and answers warm from the cache", async () => {
      const hero = await makeImage("Footer Cold");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        const cold = await imageUrlsFor([text]);

        expect(cold.get(hero.id)).toBe(`/image/${hero.filename}`);
        expect(imageLookups()).toBe(1);

        const warm = await imageUrlsFor([text]);

        // The same answers, so the rendered footer is byte-identical.
        expect(warm).toEqual(cold);
        expect(imageLookups()).toBe(1);
      });
    });

    test("never queries for texts without references", async () => {
      await withRequestContext(async () => {
        enableQueryLog();
        const first = await imageUrlsFor(["plain footer text"]);

        expect(first.size).toBe(0);
        expect(imageLookups()).toBe(0);
        expect(settingsReads()).toBe(0);

        const warm = await imageUrlsFor(["plain footer text"]);

        expect(warm.size).toBe(0);
        expect(imageLookups()).toBe(0);
        expect(settingsReads()).toBe(0);
      });
    });

    test("a settings write forces the next lookup to re-query", async () => {
      const hero = await makeImage("Footer Settings");
      const text = `![Foot](img#${hero.id})`;
      const previous = settings.siteFooter;

      await withRequestContext(async () => {
        enableQueryLog();
        await imageUrlsFor([text]);
        expect(imageLookups()).toBe(1);

        await settings.update.siteFooter(text);
        await imageUrlsFor([text]);

        expect(imageLookups()).toBe(2);
      });

      await settings.update.siteFooter(previous);
    });

    test("an images write forces the next lookup to re-query", async () => {
      const hero = await makeImage("Footer Images");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        await imageUrlsFor([text]);
        expect(imageLookups()).toBe(1);

        await insertImageRecord({
          altText: "Alt Footer Images Other",
          filename: nonEmptyString("footer-images-other.webp"),
          filenameThumb: nonEmptyString("footer-images-other-thumb.webp"),
          name: "Footer Images Other",
        });
        await imageUrlsFor([text]);

        expect(imageLookups()).toBe(2);
      });
    });

    test("a lookup that fills past the bound resets the cache", async () => {
      // 201 distinct images: the lookup's answers exceed the bound, so the
      // cache resets instead of holding them.
      const oldest = await makeImage("Bound 1");
      const images = [oldest];
      for (let index = 2; index <= 201; index++) {
        images.push(await makeImage(`Bound ${index}`));
      }
      const text = images.map((image) => `![pic](img#${image.id})`).join(" ");

      await withRequestContext(async () => {
        enableQueryLog();
        const filled = await imageUrlsFor([text]);

        expect(filled.size).toBe(201);
        expect(imageLookups()).toBe(1);

        // The cache reset, so the same id queries again and reads the same
        // answer.
        const refilled = await imageUrlsFor([`![pic](img#${oldest.id})`]);

        expect(refilled.get(oldest.id)).toBe(filled.get(oldest.id));
        expect(imageLookups()).toBe(2);

        // The refill held, so the same id now serves warm.
        const warm = await imageUrlsFor([`![pic](img#${oldest.id})`]);

        expect(warm.get(oldest.id)).toBe(filled.get(oldest.id));
        expect(imageLookups()).toBe(2);
      });
    });

    test("an images write during a lookup does not pin the pre-write table", async () => {
      const hero = await makeImage("Footer Straddle");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        // Hold the images SELECT open until the write commits, so the write
        // lands while the lookup runs on every run. The match fits only the
        // lookup's SELECT: an INSERT names INTO images, and a DELETE has no
        // filename column.
        const db = getDb();
        const realExecute = db.execute.bind(db);
        const { promise: gate, resolve: release } =
          Promise.withResolvers<void>();
        const { promise: reading, resolve: started } =
          Promise.withResolvers<void>();
        const held = stub(db, "execute", async (stmt: InStatement) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("FROM images") && sql.includes("filename")) {
            started();
            await gate;
            return realExecute(stmt);
          }
          return realExecute(stmt);
        });
        const pending = imageUrlsFor([text]);
        try {
          await reading;
        } finally {
          held.restore();
        }
        // The write runs while the SELECT sits on the gate, so the write
        // provably lands inside the lookup on every run. The write goes
        // through the version-bumping spine. The lookup's fill is stamped
        // with the pre-write version, so it cannot serve the next lookup.
        await insertImageRecord({
          altText: "Alt Footer Straddle Other",
          filename: nonEmptyString("footer-straddle-other.webp"),
          filenameThumb: nonEmptyString("footer-straddle-other-thumb.webp"),
          name: "Footer Straddle Other",
        });
        release();
        await pending;

        expect(imageLookups()).toBe(1);

        // The write landed while the lookup ran, so the next render
        // re-queries instead of serving the table the lookup filled.
        await imageUrlsFor([text]);

        expect(imageLookups()).toBe(2);
      });
    });
  },
);
