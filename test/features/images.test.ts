import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encryptBytes } from "#crypto/encryption.ts";
import { getDb } from "#db/client.ts";
import {
  addPageImageUrls,
  footerImageUrls,
  imageUrlsFor,
} from "#db/image-urls.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { renderMarkdown } from "#shared/markdown.ts";
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
            expect(response.headers.get("cache-control")).toContain(
              "immutable",
            );
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
            expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
            expect(errors.lastMessage()).toContain(
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
            expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
            expect(errors.lastMessage()).toContain(
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

        expect(renderMarkdown(`![Poster](img#${hero.id})`)).toContain(
          `src="/image/${hero.filename}"`,
        );
      });
    });

    test("writes nothing the texts do not reference", async () => {
      await makeImage("Hero");
      await withRequestContext(async () => {
        await addPageImageUrls(["plain text", null]);

        expect(renderMarkdown("![Poster](img#7)")).toContain('src=""');
      });
    });

    test("writes nothing outside a request", async () => {
      const hero = await makeImage("Hero");

      await addPageImageUrls([`![Poster](img#${hero.id})`]);

      expect(renderMarkdown(`![Poster](img#${hero.id})`)).toContain('src=""');
    });
  },
);

describeWithEnv(
  "server images > footerImageUrls memo",
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

    test("queries once cold and serves the same src warm", async () => {
      const hero = await makeImage("Footer Cold");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        const cold = await footerImageUrls(text);

        expect(cold.get(hero.id)).toBe(`/image/${hero.filename}`);
        expect(imageLookups()).toBe(1);

        const warm = await footerImageUrls(text);

        // The same table instance, so the rendered footer is byte-identical.
        expect(warm).toBe(cold);
        expect(imageLookups()).toBe(1);
      });
    });

    test("never queries for a footer without references", async () => {
      await withRequestContext(async () => {
        enableQueryLog();
        const first = await footerImageUrls("plain footer text");

        expect(first.size).toBe(0);
        expect(imageLookups()).toBe(0);
        expect(settingsReads()).toBe(0);

        const warm = await footerImageUrls("plain footer text");

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
        await footerImageUrls(text);
        expect(imageLookups()).toBe(1);

        await settings.update.siteFooter(text);
        await footerImageUrls(text);

        expect(imageLookups()).toBe(2);
      });

      await settings.update.siteFooter(previous);
    });

    test("an images write forces the next lookup to re-query", async () => {
      const hero = await makeImage("Footer Images");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        await footerImageUrls(text);
        expect(imageLookups()).toBe(1);

        await makeImage("Footer Images Other");
        await footerImageUrls(text);

        expect(imageLookups()).toBe(2);
      });
    });

    test("an images write during a lookup does not seed the slot", async () => {
      const hero = await makeImage("Footer Straddle");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        // Hold the footer's images SELECT open until the write commits, so the
        // write lands while the lookup runs on every run. The match fits only
        // the lookup's SELECT: an INSERT names INTO images, and a DELETE has
        // no filename column.
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
        const pending = footerImageUrls(text);
        try {
          await reading;
        } finally {
          held.restore();
        }
        // The write runs while the SELECT sits on the gate, so the write
        // provably lands inside the lookup on every run. makeImage writes the
        // images table without the shared version bump, so the re-query below
        // is the generation guard's work alone.
        await makeImage("Footer Straddle Other");
        release();
        await pending;

        expect(imageLookups()).toBe(1);

        // The write landed while the lookup ran, so the slot stays empty and
        // the next render re-queries instead of serving that table.
        await footerImageUrls(text);

        expect(imageLookups()).toBe(2);
      });
    });

    test("a refill after an images write reads under the primary scope", async () => {
      const hero = await makeImage("Footer Refill");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        // A file database answers every read from one file, so the primary
        // path shows up as the read's scope rather than as a remote batch.
        const db = getDb();
        const realExecute = db.execute.bind(db);
        const primaryScopes: boolean[] = [];
        const executeStub = stub(db, "execute", (stmt: InStatement) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("FROM images") && sql.includes("filename")) {
            primaryScopes.push(mustReadFromPrimary());
          }
          return realExecute(stmt);
        });
        try {
          await footerImageUrls(text);
          // A committed images write arms the refill, so the next lookup's
          // read runs under the primary scope a lagging replica cannot beat.
          await makeImage("Footer Refill Other");
          await footerImageUrls(text);
        } finally {
          executeStub.restore();
        }

        expect(primaryScopes).toHaveLength(2);
        expect(primaryScopes.at(-1)).toBe(true);
      });
    });

    test("cold callers that arrive together share one lookup", async () => {
      const hero = await makeImage("Footer Together");
      const text = `![Foot](img#${hero.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        const [first, second] = await Promise.all([
          footerImageUrls(text),
          footerImageUrls(text),
        ]);

        expect(first.get(hero.id)).toBe(`/image/${hero.filename}`);
        expect(second).toBe(first);
        expect(imageLookups()).toBe(1);
      });
    });

    test("a changed footer text does not reuse the old table", async () => {
      const hero = await makeImage("Footer Old Text");
      const next = await makeImage("Footer New Text");
      const before = `![Foot](img#${hero.id})`;
      const after = `![Foot](img#${next.id})`;

      await withRequestContext(async () => {
        enableQueryLog();
        const first = await footerImageUrls(before);

        expect(first.get(hero.id)).toBe(`/image/${hero.filename}`);
        expect(first.get(next.id)).toBeUndefined();

        const second = await footerImageUrls(after);

        expect(second.get(next.id)).toBe(`/image/${next.filename}`);
        expect(second.get(hero.id)).toBeUndefined();
        expect(imageLookups()).toBe(2);
      });
    });
  },
);
