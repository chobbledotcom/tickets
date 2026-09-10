import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import { expectErrorFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** POST a duplicate that must be rejected on name uniqueness: assert it
 * redirects back to the form, creates no new group, and creates no new
 * listing rows (a regression that wrote an orphan before rejecting would
 * pass a group-count-only check). */
const expectDuplicateRejected = async (
  groupId: number,
  body: Record<string, string>,
): Promise<void> => {
  const groupsBefore = (await groups.cache.getAll()).length;
  const listingsBefore = (await getAllListings()).length;
  const { response } = await adminFormPost(
    `/admin/groups/${groupId}/bulk-actions/duplicate`,
    body,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(
    `/admin/groups/${groupId}/bulk-actions/duplicate`,
  );
  expect((await groups.cache.getAll()).length).toBe(groupsBefore);
  expect((await getAllListings()).length).toBe(listingsBefore);
};

const duplicateForm = (
  overrides: Record<string, string>,
): Record<string, string> => ({
  date_find: "",
  date_replace: "",
  name_find: "",
  name_replace: "",
  new_name: "Copy",
  ...overrides,
});

describeWithEnv(
  "Admin bulk actions — duplicate name invariant",
  { db: true },
  () => {
    test("rejects a new group name already used by another entity", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`
      // (case `catalogue.copy-refuses-a-clashing-name`), which proves the
      // clone-name-clash refusal through the rendered form. This direct test
      // covers a different branch of the same name invariant: the new group
      // name itself clashing with an existing listing. That branch is not
      // reachable as a separate observable from the rendered form, so it stays
      // here rather than being folded into the story.
      const group = await createTestGroup({ name: "Dup Src" });
      await createTestListing({ groupId: group.id, name: "A Member" });
      await createTestListing({ name: "Taken Name" });
      await expectDuplicateRejected(
        group.id,
        duplicateForm({
          name_find: "A Member",
          name_replace: "A Clone",
          new_name: "Taken Name",
        }),
      );
    });

    test("rejects when a clone name would equal the new group name", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`.
      // The story proves the cross-entity name clash through the rendered form;
      // this direct test covers the within-batch clash (the new group name and
      // a clone name colliding inside the same batch, which no create-path
      // validator would see — caught up front by the `firstDuplicateNameError`
      // Set check), a branch the story's case does not exercise.
      const group = await createTestGroup({ name: "Collapse" });
      await createTestListing({ groupId: group.id, name: "Sole Member" });
      // The clone is renamed to exactly the new group name.
      await expectDuplicateRejected(
        group.id,
        duplicateForm({
          name_find: "Sole Member",
          name_replace: "Shared Name",
          new_name: "Shared Name",
        }),
      );
    });

    test("rejects a clone name that collides with an existing listing", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`
      // (case `catalogue.copy-refuses-a-clashing-name`), which proves the
      // clone-name-clash refusal through the rendered form. Cucumber runs do
      // not feed the deterministic coverage gate, so this direct test pins the
      // `firstDuplicateNameError` → `isNameTakenAnywhere` branch for a clone
      // name that collides with a pre-existing listing (the source itself).
      const group = await createTestGroup({ name: "Clashy" });
      await createTestListing({ groupId: group.id, name: "Only Member" });
      // A blank find/replace clones the source name verbatim, which collides
      // with the still-existing source listing.
      await expectDuplicateRejected(
        group.id,
        duplicateForm({ new_name: "Clashy Copy" }),
      );
    });

    test("rejects an empty new group name with an error flash", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`.
      // The story refuses a name clash through the real rendered form, but the
      // `new_name` field is `required` on that form, so the form-controls net
      // (and a real browser's own validation) blocks an empty value before it
      // is sent. This server-side guard catches a form-bypassing POST that
      // submits an empty `new_name` directly — a branch the rendered form
      // cannot reach, so it stays as a direct technical contract.
      const group = await createTestGroup({ name: "Needs Name" });
      await createTestListing({ groupId: group.id, name: "E" });

      const groupCountBefore = (await groups.cache.getAll()).length;

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        duplicateForm({ new_name: "" }),
      );

      expect(response.status).toBe(302);
      // Redirect back to the form, not on to a new group page
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      // The refusal names the missing field.
      expectErrorFlash(response, "New group name is required");
      expect((await groups.cache.getAll()).length).toBe(groupCountBefore);
    });
  },
);
