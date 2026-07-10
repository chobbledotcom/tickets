import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  expectNoListingsCta,
  makeParent,
  soldOutParentInGroup,
} from "#test-utils/parents.ts";

describeWithEnv(
  "server > parents booking — /listings CTA suppression",
  { db: true, triggers: true },
  () => {
    test("a group with a child-only set suppresses its CTA on /listings", async () => {
      const group = await createTestGroup({ name: "Child-only listed group" });
      await makeParent({ children: [{ groupId: group.id }] });
      // The group page itself 404s (asserted in group-pages); the /listings CTA
      // pointing at it must be suppressed so it never advertises a dead link.
      await expectNoListingsCta(group.slug);
    });

    test("a group whose only non-child member is a no-bookable-child parent suppresses its /listings CTA", async () => {
      // The group's only member is a PARENT (not a child) whose required child
      // is sold out, so the group page projects that parent sold out and offers
      // no bookable quantity. The /listings Book CTA to /ticket/<group> must be
      // suppressed too — counting the parent as a "bookable member" because it
      // isn't a child would advertise an uncompletable booking.
      const { group } = await soldOutParentInGroup("Sold-out-parent group");
      await expectNoListingsCta(group.slug);
    });
  },
);
