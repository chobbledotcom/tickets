/** The child-add-on reachability check directly: an opt-in add-on whose only
 * route to the buyer is a suppressed child earns the refusal, and reaching a
 * serving page of its own resolves the save. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { childAddOnSaveError } from "#routes/admin/modifier-add-on-reachability.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";
import { makeParent } from "#test-utils/parents.ts";

describeWithEnv("db > modifier child-add-on reachability", { db: true }, () => {
  /** The candidate for an opt-in add-on linked to the named listings. The
   * submitted scope stays "listings", so the reachable set decides alone. */
  const saveFor = (name: string, listingIds: number[]) =>
    childAddOnSaveError({
      active: true,
      groupIds: [],
      listingIds,
      name,
      scope: "listings",
      trigger: "optional",
    });

  test("an add-on reachable only through a suppressed child is refused", async () => {
    const { child } = await makeParent();
    await optInAddOnForListings("Link extra", [child.id]);

    expect(await saveFor("Link extra", [child.id])).toContain("Link extra");
  });

  test("a bookable_alone child serves its own page and resolves the save", async () => {
    const { child } = await makeParent({
      children: [{ bookableAlone: true, name: "Solo Widget" }],
    });
    await optInAddOnForListings("Link extra", [child.id]);

    expect(await saveFor("Link extra", [child.id])).toBeNull();
  });
});
