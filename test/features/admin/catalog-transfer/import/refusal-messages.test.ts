/**
 * An import runs the same listing and group validators the admin forms do, so
 * the route must load their message catalogs. Without that, a refused import
 * throws a missing-translation error and the operator gets a server error
 * instead of the reason their file was rejected.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";

describeWithEnv("catalog import refusal messages", { db: true }, () => {
  /** Import one catalog blob and report the flash message it redirected with. */
  const importAndReadFlash = async (payload: unknown): Promise<string> => {
    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockMultipartRequest(
        "/admin/catalog/import",
        { csrf_token: csrfToken },
        cookie,
        {
          contentType: "application/json",
          data: new TextEncoder().encode(JSON.stringify(payload)),
          fieldName: "catalog_file",
          name: "catalog.json",
        },
      ),
    );

    expect(response.status).toBe(302);
    const flash = response.headers.get("set-cookie") ?? "";
    return decodeURIComponent(flash);
  };

  test("a customisable-days and pay-more clash is explained, not a server error", async () => {
    const flash = await importAndReadFlash({
      kind: "listing",
      listing: {
        canPayMore: true,
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        maxAttendees: 5,
        maxPrice: 2000,
        name: "Clashing Import",
        unitPrice: 1000,
      },
      parents: [],
      version: 1,
    });

    expect(flash).toContain(t("error.customisable_days_with_pay_more"));
  });

  test("a group type clash is explained, not a server error", async () => {
    const group = await createTestGroup({ name: "Import Type Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "daily",
      name: "Daily Member",
    });

    const flash = await importAndReadFlash({
      groups: [{ group: "Import Type Group" }],
      kind: "listing",
      listing: {
        listingType: "standard",
        maxAttendees: 5,
        name: "Standard Import",
        unitPrice: 1000,
      },
      parents: [],
      version: 1,
    });

    expect(flash).toContain(
      t("error.group_listing_type_mismatch", { type: "daily" }),
    );
  });
});
