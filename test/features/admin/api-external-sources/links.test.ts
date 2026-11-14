/**
 * The external source link routes: which record kinds a link takes, the two
 * checks a write makes, the filters a read takes, and the confirmed delete.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { HYBRID_PREFIX } from "#crypto/hybrid.ts";
import { queryOne } from "#db/client.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addListing,
  createLink,
  createSource,
  linkPath,
  linksPath,
} from "#test-utils/external-sources.ts";
import { apiRequest } from "#test-utils/session.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

describeWithEnv("Admin API - External source links", { db: true }, () => {
  useSetting(featureSetting("externalSources"));

  /** One source holding two links, one per listing. */
  const linkTwoRecords = async (): Promise<{
    sourceId: number;
    first: number;
    second: number;
  }> => {
    const created = await createSource();
    const first = await addListing("Watercolour day");
    const second = await addListing("Pottery day");
    const sourceId = Number(created.source.id);
    await createLink(sourceId, {
      external_id: "INV-1",
      link_id: first.id,
      link_type: "listing",
    });
    await createLink(sourceId, {
      external_id: "INV-2",
      link_id: second.id,
      link_type: "listing",
    });
    return { first: first.id, second: second.id, sourceId };
  };

  const externalIds = (links: { external_id: string }[]): string[] =>
    links.map((link) => link.external_id);

  /** One link body that points at a listing. */
  const listingLink = (externalId: string, linkId: number) => ({
    external_id: externalId,
    link_id: linkId,
    link_type: "listing",
  });

  /** One write to a link route. */
  const sendLink = (
    method: "POST" | "PUT",
    path: string,
    body: Record<string, unknown>,
  ) => apiRequest(path, { body, method });

  /** A fresh source with one listing linked under `externalId`. */
  const linkedListing = async (externalId: string) => {
    const sourceId = await newSourceId();
    const listing = await addListing();
    const link = await createLink(
      sourceId,
      listingLink(externalId, listing.id),
    );
    return { link, listing, sourceId };
  };

  /** A fresh source's id, for the routes that only need one to exist. */
  const newSourceId = async (): Promise<number> =>
    Number((await createSource()).source.id);

  describe("POST /api/admin/external-sources/:sourceId/links", () => {
    test("links a record and answers with its opened external id", async () => {
      const { link, listing, sourceId } = await linkedListing("INV-1001");

      expect(link.link).toEqual(
        expect.objectContaining({
          external_id: "INV-1001",
          link_id: listing.id,
          link_type: "listing",
          source_id: sourceId,
        }),
      );
      expect(link.link).not.toHaveProperty("external_id_index");

      const stored = await queryOne<{ external_id: string }>(
        "SELECT external_id FROM external_source_links WHERE id = ?",
        [Number(link.link.id)],
      );
      expect(stored!.external_id.startsWith(HYBRID_PREFIX)).toBe(true);
    });

    test("refuses a body it cannot link", async () => {
      const sourceId = await newSourceId();
      const notAnId = "link_id must be a whole number of 1 or more";
      const cases: [Record<string, unknown>, string][] = [
        [listingLink("INV-404", 999_999), "No listing has id 999999"],
        [
          { external_id: "X", link_id: 7, link_type: "invoice" },
          "link_type must be one of: attendee, listing, group",
        ],
        [{ external_id: "X", link_id: 0, link_type: "listing" }, notAnId],
        [{ external_id: "X", link_id: "7", link_type: "listing" }, notAnId],
      ];
      for (const [body, error] of cases) {
        await expectApiError(
          sendLink("POST", linksPath(sourceId), body),
          400,
          error,
        );
      }
    });

    test("refuses the same record twice with one external id", async () => {
      const sourceId = await newSourceId();
      const listing = await addListing();
      await createLink(sourceId, listingLink("INV-1001", listing.id));

      await expectApiError(
        sendLink(
          "POST",
          linksPath(sourceId),
          listingLink("INV-1001", listing.id),
        ),
        400,
        "This source already links that record to that external id",
      );
    });

    test("links one external id to a second record", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const first = await addListing("Watercolour day");
      const second = await addListing("Pottery day");
      await createLink(sourceId, {
        external_id: "INV-1001",
        link_id: first.id,
        link_type: "listing",
      });

      const linked = await createLink(sourceId, {
        external_id: "INV-1001",
        link_id: second.id,
        link_type: "listing",
      });

      expect(linked.link).toEqual(
        expect.objectContaining({
          external_id: "INV-1001",
          link_id: second.id,
        }),
      );
    });

    test("refuses a blank or over-long external id", async () => {
      const sourceId = await newSourceId();
      for (const externalId of ["", "x".repeat(251)]) {
        await assertJson(
          sendLink("POST", linksPath(sourceId), listingLink(externalId, 7)),
          400,
          (body) => {
            expect(body.error).toContain("external_id");
          },
        );
      }
    });
  });

  describe("GET /api/admin/external-sources/:sourceId/links", () => {
    test("lists every link of one source", async () => {
      const { sourceId } = await linkTwoRecords();

      await assertJson(apiRequest(linksPath(sourceId)), 200, (body) => {
        expect(externalIds(body.links)).toEqual(["INV-1", "INV-2"]);
      });
    });

    test("finds the link that holds one external id", async () => {
      const { sourceId } = await linkTwoRecords();

      await assertJson(
        apiRequest(`${linksPath(sourceId)}?external_id=INV-2`),
        200,
        (body) => {
          expect(externalIds(body.links)).toEqual(["INV-2"]);
        },
      );
    });

    test("finds the links of one record", async () => {
      const { second, sourceId } = await linkTwoRecords();

      await assertJson(
        apiRequest(
          `${linksPath(sourceId)}?link_type=listing&link_id=${second}`,
        ),
        200,
        (body) => {
          expect(externalIds(body.links)).toEqual(["INV-2"]);
        },
      );
    });

    test("refuses a record filter it cannot read", async () => {
      const base = linksPath(await newSourceId());
      const cases: [string, string][] = [
        ["link_type=listing", "link_type and link_id go together"],
        [
          "link_type=invoice&link_id=7",
          "link_type must be one of: attendee, listing, group",
        ],
        [
          "link_type=listing&link_id=seven",
          "link_id must be a whole number of 1 or more",
        ],
      ];
      for (const [query, error] of cases) {
        await expectApiError(apiRequest(`${base}?${query}`), 400, error);
      }
    });
  });

  describe("PUT /api/admin/external-sources/:sourceId/links/:linkId", () => {
    test("changes the external id a record holds", async () => {
      const { link, listing, sourceId } = await linkedListing("INV-1");

      const changed = await assertJson(
        sendLink(
          "PUT",
          linkPath(sourceId, Number(link.link.id)),
          listingLink("INV-2", listing.id),
        ),
        200,
      );
      expect(changed.link.external_id).toBe("INV-2");
    });

    test("returns 404 for a link of another source", async () => {
      const first = await newSourceId();
      const second = await createSource({
        name: "Imports",
        url_pattern: "https://imports.example/{external_id}",
      });
      const listing = await addListing();
      const link = await createLink(first, listingLink("INV-1", listing.id));

      await expectApiError(
        sendLink(
          "PUT",
          linkPath(Number(second.source.id), Number(link.link.id)),
          listingLink("INV-1", listing.id),
        ),
        404,
        "Link not found",
      );
    });

    test("refuses the record it already links under that external id", async () => {
      const sourceId = await newSourceId();
      const listing = await addListing();
      await createLink(sourceId, listingLink("INV-1", listing.id));
      const second = await createLink(
        sourceId,
        listingLink("INV-2", listing.id),
      );

      await expectApiError(
        sendLink(
          "PUT",
          linkPath(sourceId, Number(second.link.id)),
          listingLink("INV-1", listing.id),
        ),
        400,
        "This source already links that record to that external id",
      );
    });
  });

  describe("DELETE /api/admin/external-sources/:sourceId/links/:linkId", () => {
    test("needs the exact external id, then deletes the link", async () => {
      const { link, sourceId } = await linkedListing("INV-1");
      const path = linkPath(sourceId, Number(link.link.id));

      await assertJson(
        apiRequest(path, {
          body: { confirm_identifier: "INV-2" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Link reference does not match");
        },
      );
      await assertJson(
        apiRequest(path, {
          body: { confirm_identifier: "INV-1" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body).toEqual({ status: "ok" });
        },
      );
      await assertJson(
        apiRequest(path, {
          body: { confirm_identifier: "INV-1" },
          method: "DELETE",
        }),
        404,
      );
    });

    test("deletes a link the other system has not named yet", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      const link = await createLink(sourceId, {
        link_id: listing.id,
        link_type: "listing",
      });
      expect(link.link.external_id).toBe(null);

      await assertJson(
        apiRequest(linkPath(sourceId, Number(link.link.id)), {
          body: { confirm_identifier: `listing ${listing.id}` },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body).toEqual({ status: "ok" });
        },
      );
    });
  });
});
