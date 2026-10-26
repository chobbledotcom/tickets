import type { InStatement } from "@libsql/client";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encryptBytes } from "#crypto/encryption.ts";
import { getDb } from "#db/client.ts";
import { addPageImageUrls, imageUrlsFor } from "#db/image-urls.ts";
import { insertImageRecord } from "#db/images.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  expectBrokenImageResponse,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { JPEG_HEADER } from "#test-utils/factories.ts";
import {
  mockRequest,
  withCdnProxy,
  withExpectedError,
  withStorageDisabled,
} from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

/** Reusable proxy route test path */
const PROXY_PATH = "/image/abc123-def4-5678-9abc-def012345678";

/** Request the image proxy route */
const proxyRequest = (ext = "jpg"): Promise<Response> =>
  handleRequest(mockRequest(`${PROXY_PATH}.${ext}`));

describeWithEnv(
  "server images > proxy",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("GET /image/:filename (proxy route)", () => {
      const errors = setupErrorSpy();

      test("serves decrypted image with correct content type", async () => {
        const imageData = JPEG_HEADER;
        const encrypted = await encryptBytes(imageData);

        await withCdnProxy(
          () => new Response(encrypted as any, { status: 200 }),
          async () => {
            const response = await proxyRequest();
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("image/jpeg");
            const cacheControl = response.headers.get("cache-control") ?? "";
            assertStringIncludes(cacheControl, "immutable");
            const body = new Uint8Array(await response.arrayBuffer());
            expect(body).toEqual(imageData);
          },
        );
      });

      test("serves the red pixel and reports when the file is missing from storage", async () => {
        await withCdnProxy(
          () => new Response("Not Found", { status: 404 }),
          async () => {
            await expectBrokenImageResponse(await proxyRequest());
            assertStringIncludes(errors.lastMessage() ?? "", "E_IMAGE_BROKEN");
            assertStringIncludes(
              errors.lastMessage() ?? "",
              "abc123-def4-5678-9abc-def012345678.jpg is missing from storage",
            );
          },
        );
      });

      test("serves the red pixel and reports when the stored file will not decrypt", async () => {
        await withCdnProxy(
          () => new Response("not encrypted bytes", { status: 200 }),
          async () => {
            await expectBrokenImageResponse(await proxyRequest());
            assertStringIncludes(errors.lastMessage() ?? "", "E_IMAGE_BROKEN");
            assertStringIncludes(
              errors.lastMessage() ?? "",
              "abc123-def4-5678-9abc-def012345678.jpg could not be decrypted",
            );
          },
        );
      });

      test("serves the red pixel for the broken-image marker path", async () => {
        const response = await handleRequest(
          mockRequest(`/image/${BROKEN_IMAGE_FILENAME}`),
        );
        await expectBrokenImageResponse(response);
        // The marker is a fallback, not a broken record in itself.
        expect(errors.calls.length).toBe(0);
      });

      test("propagates non-404 storage errors as 503", async () => {
        await withCdnProxy(
          () => new Response("Unauthorized", { status: 401 }),
          async () => {
            await withExpectedError(async () => {
              await expectHtmlResponse(
                await proxyRequest(),
                503,
                "Temporary error",
              );
            });
          },
        );
      });

      test("returns 404 for unknown extension", async () => {
        expect((await proxyRequest("bmp")).status).toBe(404);
      });

      describeWithEnv(
        "when storage is not enabled",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("returns 404", async () => {
            await withStorageDisabled(async () => {
              expect((await proxyRequest()).status).toBe(404);
            });
          });

          test("still serves the red pixel for the broken-image marker", async () => {
            await withStorageDisabled(async () => {
              await expectBrokenImageResponse(
                await handleRequest(
                  mockRequest(`/image/${BROKEN_IMAGE_FILENAME}`),
                ),
              );
            });
          });
        },
      );

      // The pipeline fast-404s a body-bearing POST to this GET-only prefix
      // before it routes, so HEAD is the method that still reaches the
      // handler's own method check.
      test("returns 404 for a HEAD request (the handler is GET-only)", async () => {
        const response = await handleRequest(
          mockRequest(`${PROXY_PATH}.jpg`, { method: "HEAD" }),
        );
        expect(response.status).toBe(404);
      });

      test("answers a POST with a silent bare 404 before the body read", async () => {
        const response = await handleRequest(
          new Request(`http://localhost${PROXY_PATH}.jpg`, {
            body: "test",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
            },
            method: "POST",
          }),
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
        expect(errors.calls.length).toBe(0);
      });

      test("returns 404 for filename without extension", async () => {
        const response = await handleRequest(
          mockRequest("/image/abcdef123456"),
        );
        expect(response.status).toBe(404);
      });
    });

    test("never serves an id-addressed image route", async () => {
      // The image library is not enumerable: an id path is just an unknown
      // filename, whatever ids exist.
      const image = await makeImage("Hero");
      const known = await handleRequest(mockRequest(`/image/id/${image.id}`));
      expect(known.status).toBe(404);
      const unknown = await handleRequest(mockRequest("/image/id/424242"));
      expect(unknown.status).toBe(404);
    });

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

        assertStringIncludes(renderMarkdown("![Poster](img#7)"), 'src=""');
      });
    });

    test("writes nothing outside a request", async () => {
      const hero = await makeImage("Hero");

      await addPageImageUrls([`![Poster](img#${hero.id})`]);

      assertStringIncludes(
        renderMarkdown(`![Poster](img#${hero.id})`),
        'src=""',
      );
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
