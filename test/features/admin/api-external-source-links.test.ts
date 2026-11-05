/**
 * The external source link routes: which record kinds a link takes, the two
 * checks a write makes, the filters a read takes, and the confirmed delete.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { HYBRID_PREFIX } from "#crypto/hybrid.ts";
import { queryOne } from "#db/client.ts";
import { assertJson } from "#test-utils/assertions.ts";
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

  describe("POST /api/admin/external-sources/:sourceId/links", () => {
    test("links a record and answers with its opened external id", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();

      const link = await createLink(sourceId, {
        external_id: "INV-1001",
        link_id: listing.id,
        link_type: "listing",
      });

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

    test("refuses a record that does not exist", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(linksPath(Number(created.source.id)), {
          body: {
            external_id: "INV-404",
            link_id: 999_999,
            link_type: "listing",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("No listing has id 999999");
        },
      );
    });

    test("refuses the same record twice with one external id", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      await createLink(sourceId, {
        external_id: "INV-1001",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(linksPath(sourceId), {
          body: {
            external_id: "INV-1001",
            link_id: listing.id,
            link_type: "listing",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "This source already links that record to that external id",
          );
        },
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

    test("refuses a link kind the directory does not name", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(linksPath(Number(created.source.id)), {
          body: { external_id: "X", link_id: 7, link_type: "invoice" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "link_type must be one of: attendee, listing, group",
          );
        },
      );
    });

    test("refuses a link id that is not a whole number of 1 or more", async () => {
      const created = await createSource();
      for (const linkId of [0, "7"]) {
        await assertJson(
          apiRequest(linksPath(Number(created.source.id)), {
            body: { external_id: "X", link_id: linkId, link_type: "listing" },
            method: "POST",
          }),
          400,
          (body) => {
            expect(body.error).toBe(
              "link_id must be a whole number of 1 or more",
            );
          },
        );
      }
    });

    test("refuses a blank or over-long external id", async () => {
      const created = await createSource();
      for (const externalId of ["", "x".repeat(251)]) {
        await assertJson(
          apiRequest(linksPath(Number(created.source.id)), {
            body: {
              external_id: externalId,
              link_id: 7,
              link_type: "listing",
            },
            method: "POST",
          }),
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

    test("refuses half a record filter", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(`${linksPath(Number(created.source.id))}?link_type=listing`),
        400,
        (body) => {
          expect(body.error).toBe("link_type and link_id go together");
        },
      );
    });

    test("refuses a filter value it cannot read", async () => {
      const created = await createSource();
      const base = linksPath(Number(created.source.id));
      await assertJson(
        apiRequest(`${base}?link_type=invoice&link_id=7`),
        400,
        (body) => {
          expect(body.error).toBe(
            "link_type must be one of: attendee, listing, group",
          );
        },
      );
      await assertJson(
        apiRequest(`${base}?link_type=listing&link_id=seven`),
        400,
        (body) => {
          expect(body.error).toBe(
            "link_id must be a whole number of 1 or more",
          );
        },
      );
    });
  });

  describe("PUT /api/admin/external-sources/:sourceId/links/:linkId", () => {
    test("changes the external id a record holds", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      const link = await createLink(sourceId, {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(linkPath(sourceId, Number(link.link.id)), {
          body: {
            external_id: "INV-2",
            link_id: listing.id,
            link_type: "listing",
          },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.link.external_id).toBe("INV-2");
        },
      );
    });

    test("returns 404 for a link of another source", async () => {
      const first = await createSource();
      const second = await createSource({
        name: "Imports",
        url_pattern: "https://imports.example/{external_id}",
      });
      const listing = await addListing();
      const link = await createLink(Number(first.source.id), {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(linkPath(Number(second.source.id), Number(link.link.id)), {
          body: {
            external_id: "INV-1",
            link_id: listing.id,
            link_type: "listing",
          },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Link not found");
        },
      );
    });

    test("refuses the record it already links under that external id", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      await createLink(sourceId, {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });
      const second = await createLink(sourceId, {
        external_id: "INV-2",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(linkPath(sourceId, Number(second.link.id)), {
          body: {
            external_id: "INV-1",
            link_id: listing.id,
            link_type: "listing",
          },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "This source already links that record to that external id",
          );
        },
      );
    });
  });

  describe("DELETE /api/admin/external-sources/:sourceId/links/:linkId", () => {
    test("needs the exact external id, then deletes the link", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      const link = await createLink(sourceId, {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });
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
