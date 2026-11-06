/**
 * The two reads that answer "where else does this appear?": every source's
 * links for one record, and the record one external id names.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addListing,
  createLink,
  createSource,
  linksPath,
} from "#test-utils/external-sources.ts";
import { apiRequest } from "#test-utils/session.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

describeWithEnv("Admin API - External link search", { db: true }, () => {
  useSetting(featureSetting("externalSources"));

  describe("GET /api/admin/external-sources/links", () => {
    test("lists one record's links from every source", async () => {
      const first = await createSource();
      const second = await createSource({
        name: "Imports",
        url_pattern: "https://imports.example/{external_id}",
      });
      const listing = await addListing();
      await createLink(Number(first.source.id), {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });
      await createLink(Number(second.source.id), {
        external_id: "IMP-1",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(
          `/api/admin/external-sources/links?link_type=listing&link_id=${listing.id}`,
        ),
        200,
        (body) => {
          expect(body.links).toEqual([
            expect.objectContaining({
              external_id: "INV-1",
              source_id: Number(first.source.id),
              source_name: first.source.name,
            }),
            expect.objectContaining({
              external_id: "IMP-1",
              source_id: Number(second.source.id),
              source_name: "Imports",
            }),
          ]);
        },
      );
    });

    test("refuses a search without a record", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources/links?link_type=listing"),
        400,
        (body) => {
          expect(body.error).toBe("link_type and link_id go together");
        },
      );
    });

    test("names every record one external id holds", async () => {
      const source = await createSource();
      const sourceId = Number(source.source.id);
      const first = await addListing("Watercolour day");
      const second = await addListing("Pottery day");
      await createLink(sourceId, {
        external_id: "INV-1",
        link_id: first.id,
        link_type: "listing",
      });
      await createLink(sourceId, {
        external_id: "INV-1",
        link_id: second.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(`${linksPath(sourceId)}?external_id=INV-1`),
        200,
        (body) => {
          expect(body.links).toEqual([
            expect.objectContaining({ link_id: first.id }),
            expect.objectContaining({ link_id: second.id }),
          ]);
        },
      );
    });
  });

  describe("GET /api/admin/external-sources/lookup", () => {
    test("finds the record an external id names in every source", async () => {
      const first = await createSource();
      const second = await createSource({
        name: "Imports",
        url_pattern: "https://imports.example/{external_id}",
      });
      const listing = await addListing();
      await createLink(Number(first.source.id), {
        external_id: "SHARED-1",
        link_id: listing.id,
        link_type: "listing",
      });
      await createLink(Number(second.source.id), {
        external_id: "SHARED-1",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest("/api/admin/external-sources/lookup?external_id=SHARED-1"),
        200,
        (body) => {
          expect(body.links).toEqual([
            expect.objectContaining({
              link_id: listing.id,
              source_name: first.source.name,
              url: "https://dashboard.stripe.com/invoices/SHARED-1",
            }),
            expect.objectContaining({
              link_id: listing.id,
              source_name: "Imports",
              url: "https://imports.example/SHARED-1",
            }),
          ]);
        },
      );
    });

    test("answers nothing for an id no source holds", async () => {
      await createSource();

      await assertJson(
        apiRequest("/api/admin/external-sources/lookup?external_id=UNKNOWN"),
        200,
        (body) => {
          expect(body.links).toEqual([]);
        },
      );
    });

    test("answers nothing when the directory holds no sources", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources/lookup?external_id=ANY"),
        200,
        (body) => {
          expect(body.links).toEqual([]);
        },
      );
    });

    test("refuses a lookup without an external id", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources/lookup"),
        400,
        (body) => {
          expect(body.error).toBe("external_id is required");
        },
      );
    });
  });
});
