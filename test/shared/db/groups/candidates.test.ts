/**
 * Tests for the group "add listings" candidate read
 * (`src/shared/db/groups/candidates.ts`).
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingsNotInGroup } from "#db/groups/candidates.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > groups > add-listing candidates", { db: true }, () => {
  test("the add-listing candidates exclude current members", async () => {
    const group = await createTestGroup({ name: "Candidate Group" });
    await createTestListing({ groupId: group.id, name: "Current Member" });
    const candidate = await createTestListing({ name: "Candidate" });

    expect((await getListingsNotInGroup(group.id)).map(({ id }) => id)).toEqual(
      [candidate.id],
    );
  });

  test("a candidate that inherits its bookable days reports the inherited ones", async () => {
    // The picker sorts daily listings by their next bookable date, which reads
    // the inherited availability fields — so a candidate must arrive with the
    // site defaults already applied, not with its own stored values.
    await settings.update.listingDefaults({ bookableDays: ["Saturday"] });
    const group = await createTestGroup({ name: "Inheriting Candidates" });
    const candidate = await createTestListing({
      bookableDays: ["Monday"],
      listingType: "daily",
      name: "Inheriting Candidate",
      useDefaults: true,
    });

    const candidates = await getListingsNotInGroup(group.id);

    expect(
      candidates.find(({ id }) => id === candidate.id)?.bookable_days,
    ).toEqual(["Saturday"]);
  });
});
