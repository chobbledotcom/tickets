/** The modifier links save directly: what the checkboxes' ids must look like
 * for a link to write, and what a blocked scope save leaves behind. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifierListings } from "#db/modifiers.ts";
import { t } from "#i18n";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  insertModifier,
  optInAddOnForListings,
  patchModifier,
} from "#test-utils/modifiers.ts";
import { makeParent } from "#test-utils/parents.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("db > admin modifier links", { db: true }, () => {
  /** A listings-scoped, active, opt-in modifier with no links yet. */
  const seedScopedModifier = async (name: string) => {
    const modifier = await insertModifier({ name });
    await patchModifier(modifier.id, {
      active: 1,
      scope: "listings",
      trigger: "optional",
    });
    return modifier;
  };

  test("links the positive integers and drops every hole the group submits", async () => {
    const { id } = await seedScopedModifier("Checked");
    const linked = await createTestListing({ name: "Linked" });
    const alsoLinked = await createTestListing({ name: "Also linked" });

    const { response } = await adminFormPost(`/admin/modifiers/${id}/links`, {
      // A checkbox group submits one entry per checked id; holes never write.
      listing_ids: [
        String(linked.id),
        String(alsoLinked.id),
        "0",
        "-3",
        "oops",
      ],
    });
    await expectFlashRedirect(
      `/admin/modifiers/${id}/edit`,
      "Scope updated",
    )(response);

    expect(await modifierListings.getIds(id)).toEqual([
      linked.id,
      alsoLinked.id,
    ]);
  });

  test("a blocked scope save writes no links but keeps the edit reachable", async () => {
    const { id } = await seedScopedModifier("Blocked");
    const { child } = await makeParent();
    await optInAddOnForListings("Link extra", [child.id]);

    const { response } = await adminFormPost(`/admin/modifiers/${id}/links`, {
      listing_ids: String(child.id),
    });
    await expectFlashRedirect(
      `/admin/modifiers/${id}/edit`,
      t("modifiers.err_child_only_addon", { name: "Blocked" }),
      false,
    )(response);

    expect(await modifierListings.getIds(id)).toEqual([]);
  });
});
