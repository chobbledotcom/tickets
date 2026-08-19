/**
 * The tab strip of a listing's record page: which tabs each role, feature and
 * kind of listing is offered, and which one a bare URL opens.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, createTestManagerSession } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

/** The tab strip as slug → label. The default tab has an empty slug. */
const tabsOf = async (
  listingId: number,
  cookie?: string,
): Promise<Record<string, string>> => {
  const path = `/admin/listing/${listingId}`;
  const response = cookie
    ? await awaitTestRequest(path, { cookie })
    : await adminGet(path);
  const html = await response.text();
  const strip = html.slice(
    html.indexOf('class="entity-tabs"'),
    html.indexOf("</nav>", html.indexOf('class="entity-tabs"')),
  );
  const pattern = new RegExp(
    `href="/admin/listing/${listingId}(/(\\w+))?"[^>]*>([^<]+)<`,
    "g",
  );
  return Object.fromEntries(
    [...strip.matchAll(pattern)].map((one) => [one[2] ?? "", one[3]!]),
  );
};

describeWithEnv("the tabs a listing offers", { db: true }, () => {
  test("names each one it shows an owner", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Full" });

    expect(await tabsOf(listing.id)).toEqual({
      "": "Overview",
      actions: "Actions",
      activity: "Activity",
      attendees: "Attendees",
      edit: "Edit",
      qr: "Booking QR",
      scanner: "Scanner",
    });
  });

  test("adds the owner-only feature tabs once their features are on", async () => {
    settings.setForTest(featureSetting("attributes", "questions"));
    try {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Featured",
      });

      const tabs = await tabsOf(listing.id);
      expect(tabs.attributes).toBe("Attributes");
      expect(tabs.questions).toBe("Questions");
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });

  test("keeps those feature tabs from a manager", async () => {
    settings.setForTest(featureSetting("attributes", "questions"));
    try {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Featured For Staff",
      });
      const cookie = await createTestManagerSession();

      const tabs = await tabsOf(listing.id, cookie);
      expect(tabs.attributes).toBeUndefined();
      expect(tabs.questions).toBeUndefined();
    } finally {
      settings.clearTestOverride("enabled_features");
    }
  });

  test("adds the images tab once somewhere to put them is configured", async () => {
    using _env = withEnv({
      STORAGE_ZONE_KEY: "test-key",
      STORAGE_ZONE_NAME: "test-zone",
    });
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "With Images",
    });

    expect((await tabsOf(listing.id)).images).toBe("Images");
  });

  test("opens on the overview when the URL names no tab", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Default Tab",
    });

    const html = await (await adminGet(`/admin/listing/${listing.id}`)).text();

    expect(html).toContain(
      `<a aria-current="page" class="active" href="/admin/listing/${listing.id}">Overview</a>`,
    );
  });

  test("sends the overview's activity preview to the activity tab", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Preview",
    });

    const html = await (await adminGet(`/admin/listing/${listing.id}`)).text();

    expect(html).toContain(
      `<a href="/admin/listing/${listing.id}/activity">${t("entity.view_all_activity")}</a>`,
    );
  });
});

describeWithEnv("the tabs a listing does not offer", { db: true }, () => {
  test("no scanner on a listing nobody checks in to", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "No Check In",
      purchaseOnly: true,
    });

    expect((await tabsOf(listing.id)).scanner).toBeUndefined();
  });

  test("no booking QR on a listing only reachable through its parent", async () => {
    const parent = await createTestListing({
      maxAttendees: 10,
      name: "Parent",
    });
    const child = await createTestListing({ maxAttendees: 10, name: "Child" });
    await listingChildren.setIds(parent.id, [child.id]);

    expect((await tabsOf(child.id)).qr).toBeUndefined();
    expect((await tabsOf(parent.id)).qr).toBe("Booking QR");
  });

  test("no booking QR on a member of a package that hides its members", async () => {
    const hidden = await createTestGroup({ isPackage: true, name: "Hidden" });
    await groups.table.update(hidden.id, { hidePackageListings: true });
    const member = await createTestListing({
      groupId: hidden.id,
      maxAttendees: 10,
      name: "Collapsed",
    });

    expect((await tabsOf(member.id)).qr).toBeUndefined();
  });
});
