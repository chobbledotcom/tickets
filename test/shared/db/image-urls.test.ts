import type { InStatement, InValue } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import {
  addFooterImageUrls,
  addPageImageUrls,
  addTicketPageImageUrls,
  imageUrlsFor,
} from "#db/image-urls.ts";
import { settings } from "#db/settings.ts";
import { flushPendingWork } from "#shared/pending-work.ts";
import {
  currentRequestStore,
  getPageImageUrls,
} from "#shared/request-context.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describeWithEnv(
  "db > image urls",
  { db: true, env: { NTFY_URL: undefined } },
  () => {
    describe("page image urls", () => {
      /** The request's page-image slot as id-sorted [id, url] pairs. */
      const slotEntries = (): [number, string][] =>
        [...(currentRequestStore()?.pageImageUrls ?? [])].sort(
          (a, b) => a[0] - b[0],
        );

      test("writes one ticket page's references into the request's page-image slot", async () => {
        const poster = await makeImage("Poster");
        const kit = await makeImage("Kit");
        const coast = await makeImage("Coast");
        const dune = await makeImage("Dune");
        const anchor = await makeImage("Anchor");

        await withRequestContext(async () => {
          await addTicketPageImageUrls({
            groupDescription: `![Coast](img#${coast.id})`,
            listings: [
              { listing: { description: null } },
              { listing: { description: `![Poster](img#${poster.id})` } },
            ],
            packages: [
              { description: "plain words" },
              {
                description: `![Anchor](img#${anchor.id}) ![Ghost](img#424242) img#0`,
              },
            ],
            questions: [
              { text: "no image named here" },
              { text: `![Kit](img#${kit.id})` },
            ],
            terms: `![Dune](img#${dune.id})`,
          });

          expect(slotEntries()).toEqual([
            [poster.id, "/image/poster.webp"],
            [kit.id, "/image/kit.webp"],
            [coast.id, "/image/coast.webp"],
            [dune.id, "/image/dune.webp"],
            [anchor.id, "/image/anchor.webp"],
          ]);
        });
      });

      test("adds one page's urls beside an earlier loader's", async () => {
        const poster = await makeImage("Poster");
        const anchor = await makeImage("Anchor");

        await withRequestContext(async () => {
          await addPageImageUrls([`![Poster](img#${poster.id})`]);
          await addTicketPageImageUrls({
            listings: [],
            packages: [{ description: `![Anchor](img#${anchor.id})` }],
            questions: [],
          });

          expect(slotEntries()).toEqual([
            [poster.id, "/image/poster.webp"],
            [anchor.id, "/image/anchor.webp"],
          ]);
        });
      });

      test("writes an empty slot when no text names an image", async () => {
        await withRequestContext(async () => {
          await addTicketPageImageUrls({
            listings: [{ listing: { description: null } }],
            packages: [{ description: "plain words only" }],
            questions: [],
          });

          expect(getPageImageUrls().size).toBe(0);
        });
      });

      test("stays silent outside a request", async () => {
        await addPageImageUrls(["![Poster](img#1)"]);
        await addTicketPageImageUrls({
          listings: [],
          packages: [{ description: "![Anchor](img#2)" }],
          questions: [],
        });

        expect(currentRequestStore()).toBeUndefined();
      });
    });

    describe("the img#N lookups", () => {
      test("resolves the texts' img#N references to their proxy URLs", async () => {
        const first = await makeImage("LookOne");
        const second = await makeImage("LookTwo");
        const urls = await imageUrlsFor([
          `See ![one](img#${first.id}) and ![two](img#${second.id}).`,
        ]);
        expect(urls.size).toBe(2);
        expect(urls.get(first.id)).toBe(`/image/${first.filename}`);
        expect(urls.get(second.id)).toBe(`/image/${second.filename}`);
      });

      test("looks up exactly the ids the texts reference", async () => {
        // img#0 sits below the first autoincrement id and must not reach the
        // lookup's id list. img#1 must reach it even when no row carries it.
        const db = getDb();
        const realExecute = db.execute.bind(db);
        const ran: InStatement[] = [];
        const executeStub = stub(db, "execute", (stmt: InStatement) => {
          ran.push(stmt);
          return realExecute(stmt);
        });
        try {
          await imageUrlsFor(["![a](img#0) ![b](img#1)"]);
        } finally {
          executeStub.restore();
        }
        const statements = ran.filter(
          (stmt): stmt is { sql: string; args: InValue[] } =>
            typeof stmt !== "string",
        );
        expect(statements).toEqual([
          { args: [1], sql: expect.stringContaining("id IN (?)") },
        ]);
      });

      test("answers an overlong img# reference with no image", async () => {
        // A 400-digit id overflows to Infinity, which no binder accepts.
        const urls = await imageUrlsFor([`![Poster](img#${"9".repeat(400)})`]);

        expect(urls.size).toBe(0);
      });

      test("writes the texts' table into the request's page-image slot", async () => {
        const image = await makeImage("PageRef");
        await withRequestContext(async () => {
          await addPageImageUrls([`![PageRef](img#${image.id})`]);
          expect(currentRequestStore()?.pageImageUrls?.get(image.id)).toBe(
            `/image/${image.filename}`,
          );
        });
      });
    });

    describe("the footer's image table", () => {
      const errorSpy = setupErrorSpy();

      test("does nothing outside a request", async () => {
        // The footer names an image, so a missing request guard would run the
        // lookup; the recording must stay empty.
        await settings.update.siteFooter("![Outside](img#1)");
        const db = getDb();
        const realExecute = db.execute.bind(db);
        const ran: string[] = [];
        const executeStub = stub(db, "execute", (stmt: InStatement) => {
          ran.push(typeof stmt === "string" ? stmt : stmt.sql);
          return realExecute(stmt);
        });
        try {
          await addFooterImageUrls();
        } finally {
          executeStub.restore();
        }
        expect(ran).toEqual([]);
      });

      test("logs a failed lookup and leaves the footer without its images", async () => {
        await settings.update.siteFooter("![Broken](img#1)");
        const db = getDb();
        const executeStub = stub(db, "execute", () => {
          throw new Error("connection refused");
        });
        try {
          await withRequestContext(async () => {
            await addFooterImageUrls();
            expect(currentRequestStore()?.footerImageUrls?.size).toBe(0);
            expect(
              errorSpy.contains(
                'E_DB_QUERY detail="Site footer image lookup failed"',
              ),
            ).toBe(true);
            await flushPendingWork();
          });
        } finally {
          executeStub.restore();
        }
      });
    });
  },
);
