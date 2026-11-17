/**
 * The external source link routes' activity lines, and the refusals that turn
 * on a missing, blank, or empty value.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { activityMessages } from "#test-utils/activity-log.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addListing,
  createLink,
  createSource,
  linkPath,
  linksPath,
  SOURCE_BODY,
  sourcePath,
} from "#test-utils/external-sources.ts";
import { apiRequest } from "#test-utils/session.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

describeWithEnv("Admin API - External sources activity", { db: true }, () => {
  useSetting(featureSetting("externalSources"));

  /** A fresh source and listing, as the ids the link routes take. */
  const sourceAndListing = async () => {
    const created = await createSource();
    const listing = await addListing();
    return { listingId: listing.id, sourceId: Number(created.source.id) };
  };

  const source = SOURCE_BODY.name;
  // The log reads newest first. The setup's own lines come last.
  const setupLines = [
    "Listing 'Watercolour day' created",
    `Source '${source}' created`,
  ];

  describe("link activity lines", () => {
    test("a create, an update, and a delete each log their line once", async () => {
      const { listingId, sourceId } = await sourceAndListing();
      const link = await createLink(sourceId, {
        external_id: "INV-7",
        link_id: listingId,
        link_type: "listing",
      });
      const path = linkPath(sourceId, Number(link.link.id));
      const body = { external_id: "INV-8", link_id: listingId };
      await assertJson(
        apiRequest(path, {
          body: { ...body, link_type: "listing" },
          method: "PUT",
        }),
        200,
      );
      await assertJson(
        apiRequest(path, {
          body: { confirm_identifier: "INV-8" },
          method: "DELETE",
        }),
        200,
      );

      expect(await activityMessages()).toEqual([
        `External link 'INV-8' deleted from '${source}'`,
        `External link 'INV-8' updated in '${source}'`,
        `External link 'INV-7' added to '${source}'`,
        ...setupLines,
      ]);
    });

    test("a link with no external id names its record", async () => {
      const { listingId, sourceId } = await sourceAndListing();
      await createLink(sourceId, { link_id: listingId, link_type: "listing" });
      expect(await activityMessages()).toEqual([
        `External link 'listing ${listingId}' added to '${source}'`,
        ...setupLines,
      ]);
    });
  });

  describe("refusals", () => {
    /** Update a fresh source with one body. */
    const putNewSource = async (body: Record<string, unknown>) => {
      const created = await createSource();
      return apiRequest(sourcePath(Number(created.source.id)), {
        body,
        method: "PUT",
      });
    };

    test("an update refuses an empty name, not keeping the stored one", async () => {
      await expectApiError(
        putNewSource({ name: "" }),
        400,
        "name cannot be empty",
      );
    });

    test("an update refuses an empty URL pattern, not keeping the stored one", async () => {
      await expectApiError(
        putNewSource({ url_pattern: "" }),
        400,
        "url_pattern cannot be empty",
      );
    });

    test("a links read refuses a record id without its kind", async () => {
      const { sourceId } = await sourceAndListing();
      await expectApiError(
        apiRequest(`${linksPath(sourceId)}?link_id=1`),
        400,
        "link_type and link_id go together",
      );
    });

    test("a lookup refuses an external id of only spaces", async () => {
      await expectApiError(
        apiRequest("/api/admin/external-sources/lookup?external_id=%20%20"),
        400,
        "external_id is required",
      );
    });
  });
});
