import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { handleRequest } from "#routes";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import {
  expectErrorFlash,
  expectFlash,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import {
  adminFormPost,
  getBulkActionForm,
  testCookie,
} from "#test-utils/session.ts";

const getDuplicateForm = getBulkActionForm("duplicate");

describeWithEnv("Admin bulk actions — duplicate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/duplicate", () => {
    test("shows an empty-state message when the group has no listings", async () => {
      const group = await createTestGroup({ name: "Empty" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("This group has no listings");
    });

    test("renders the duplicate form with listing preview data", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`,
      // which opens the form and submits it. The story exercises the GET route
      // indirectly, but `fillInAndSend` reads fields by name — so a regression
      // that stopped rendering the preview section (while the form fields still
      // sent) would pass the story. This GET test pins the route's duty to load
      // the group's members and pass them to the template.
      const group = await createTestGroup({ name: "Original" });
      await createTestListing({ groupId: group.id, name: "Spring Workshop" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("Spring Workshop");
      expect(html).toContain("Original (copy)");
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/duplicate", () => {
    test("refuses a duplicate whose generated names pass the catalog length cap", async () => {
      // Regression: the batch insert bypasses the create-path validators, so
      // the duplicate flow re-checks the catalog-name rules itself. Without
      // the length leg, an over-long new group name or find/replace result
      // was stored, and its Square line later failed at the name cap.
      const group = await createTestGroup({ name: "Lengthy Source" });
      await createTestListing({
        groupId: group.id,
        name: "Lengthy Member",
      });

      const overLongGroup = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Lengthy",
          name_replace: "Long",
          new_name: "N".repeat(251),
        },
      );
      expectFlash(
        overLongGroup.response,
        "Name must be 250 characters or fewer",
        false,
      );

      const overLongClone = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Lengthy",
          name_replace: "L".repeat(251),
          new_name: "Short Copy",
        },
      );
      expectFlash(
        overLongClone.response,
        "Name must be 250 characters or fewer",
        false,
      );
      expect(
        (await groups.cache.getAll()).some((g) => g.name === "Short Copy"),
      ).toBe(false);
    });

    test("returns 404 when the source group does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/groups/999999/bulk-actions/duplicate",
        { new_name: "Orphan" },
      );
      expect(response.status).toBe(404);
    });

    test("refuses to duplicate a group that contains a built-site plan", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const group = await createTestGroup({ name: "Plan Source" });
      const plan = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        name: "Duplicated Plan",
      });
      const { setListingGroups } = await import("#db/groups.ts");
      await setListingGroups(plan.id, [group.id]);

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Duplicated",
          name_replace: "Cloned",
          new_name: "Plan Copy",
        },
      );

      // The whole duplication is rejected: the clone would be a built-site
      // plan inside a group, which no save path may write.
      expectErrorFlash(response, sitePlanMemberError("Cloned Plan"));
      expect(
        (await groups.cache.getAll()).find((g) => g.name === "Plan Copy"),
      ).toBeUndefined();
    });

    /** Post a duplicate whose new name equals the source group's own name, so
     * the name check fails, then follow the error redirect and return the
     * restored form page's HTML. */
    const postFailingDuplicateAndGetForm = async (
      groupId: number,
      values: TestFormValues,
    ): Promise<string> => {
      const { response } = await adminFormPost(
        `/admin/groups/${groupId}/bulk-actions/duplicate`,
        values,
      );
      expectErrorFlash(response, "already exists");
      return await (
        await followRedirectWithFlash(
          response,
          handleRequest,
          await testCookie(),
        )
      ).text();
    };

    const FAILED_DUPLICATE_VALUES: TestFormValues = {
      date_find: "2026-03-02",
      date_replace: "2026-03-09",
      name_find: "First",
      name_replace: "Second",
      new_name: "Summer Tour",
    };

    test("keeps the submitted values when the duplicate fails", async () => {
      const group = await createTestGroup({ name: "Summer Tour" });
      await createTestListing({ groupId: group.id, name: "First Night" });

      const html = await postFailingDuplicateAndGetForm(
        group.id,
        FAILED_DUPLICATE_VALUES,
      );

      // Every field must still show what the owner submitted, so a failed
      // duplicate costs no retyping.
      expect(html).toContain('value="Summer Tour"');
      expect(html).toContain('value="First"');
      expect(html).toContain('value="Second"');
      expect(html).toContain('value="2026-03-02"');
      expect(html).toContain('value="2026-03-09"');
    });

    test("rebuilds the preview from the restored replacements", async () => {
      const group = await createTestGroup({ name: "Summer Tour" });
      await createTestListing({
        date: "2026-03-02T18:00",
        groupId: group.id,
        name: "First Night",
      });

      const html = await postFailingDuplicateAndGetForm(
        group.id,
        FAILED_DUPLICATE_VALUES,
      );

      // The preview table must already carry the restored replacements:
      // the new-name and new-date cells show the computed result, not the
      // source listing's own values.
      expect(html).toMatch(/data-preview-new-name[^>]*>Second Night<\/td>/);
      expect(html).toMatch(/data-preview-new-date[^>]*>2026-03-09 18:00<\/td>/);
      expect(html).toMatch(/data-preview-original-name[^>]*>First Night<\/td>/);
      expect(html).toMatch(
        /data-preview-original-date[^>]*>2026-03-02 18:00<\/td>/,
      );
    });
  });
});
