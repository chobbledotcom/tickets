import type { InStatement, InValue } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { executeBatch, getDb, queryAll } from "#db/client.ts";
import {
  addFooterImageUrls,
  addPageImageUrls,
  addTicketPageImageUrls,
  appendImageToItem,
  clearImageUsesForItemStatement,
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageFilenamesForItem,
  getImagesForItem,
  getImageUsesForImage,
  imagesTable,
  imageUrlsFor,
  imageUseTargets,
  setImagesForItem,
  setItemsForImage,
} from "#db/images.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { settings } from "#db/settings.ts";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import {
  currentRequestStore,
  getPageImageUrls,
} from "#shared/request-context.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { insertBrokenImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { Image } from "#types";

      expect(urls.size).toBe(0);
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
