import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { handleRequest } from "#routes";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const robotsTagFor = async (path: string): Promise<Headers> =>
  (await handleRequest(mockRequest(path))).headers;

describeWithEnv(
  "robots headers on a public thing's own page",
  { db: true, triggers: true },
  () => {
    const groupKinds = [
      { isPackage: false, label: "group" },
      { isPackage: true, label: "package" },
    ] as const;
    const visibilityCases = [
      {
        expected: "index, follow",
        groupHidden: false,
        memberHidden: true,
        name: "uses its visible setting when its member is kept off the list",
      },
      {
        expected: "noindex, nofollow",
        groupHidden: true,
        memberHidden: false,
        name: "uses its hidden setting when its member is visible",
      },
    ] as const;

    for (const kind of groupKinds) {
      for (const visibility of visibilityCases) {
        test(`${kind.label} ${visibility.name}`, async () => {
          const group = await createTestGroup({
            hidden: visibility.groupHidden,
            isPackage: kind.isPackage,
            name: `Robots ${kind.label}`,
          });
          await createTestListing({
            groupId: group.id,
            hidden: visibility.memberHidden,
            maxAttendees: 50,
            name: `Robots ${kind.label} member`,
          });

          expect(
            (await robotsTagFor(`/ticket/${group.slug}`)).get("x-robots-tag"),
          ).toBe(visibility.expected);
        });
      }
    }

    test("tells robots to index a listing anybody can find", async () => {
      const listing = await createTestListing();
      expect(
        (await robotsTagFor(`/ticket/${listing.slug}`)).get("x-robots-tag"),
      ).toBe("index, follow");
    });

    test("indexes a visible listing inside a concealing package", async () => {
      await enablePublicSite();
      const group = await createTestGroup({
        isPackage: true,
        name: "Private Kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Separate Unit",
      });

      const html = await assertPublicHtml(
        "/listings",
        "Private Kit",
        "Separate Unit",
      );
      expect(html).toContain(`href="/ticket/${listing.slug}"`);
      expect(
        (await robotsTagFor(`/ticket/${listing.slug}`)).get("x-robots-tag"),
      ).toBe("index, follow");
    });

    test("tells robots to leave a listing kept off the list alone", async () => {
      const listing = await createTestListing({ hidden: true });
      const headers = await robotsTagFor(`/ticket/${listing.slug}`);
      expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(headers.has("x-robots-noindex")).toBe(false);
    });
  },
);
