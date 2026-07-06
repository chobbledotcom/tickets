/**
 * Create opt-in add-ons scoped to a set of listings or groups, for the
 * child-listing reachability suites. A child add-on that only one page can
 * reach is what the parent/child edge guards protect, so many tests set one up
 * the same way: make an optional modifier, then wire it to some listings (or
 * some groups). Both flavours share one curried builder.
 */

import {
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";

/** Build an "insert an active opt-in add-on scoped to these ids" helper for a
 *  given scope and the matching link function. The returned helper takes the
 *  add-on name and the ids to wire it to. */
const addOnScopedTo =
  (
    scope: "groups" | "listings",
    link: (modifierId: number, id: number) => Promise<unknown>,
  ) =>
  async (name: string, ids: number[]): Promise<void> => {
    const modifier = await insertModifier({ name });
    await patchModifier(modifier.id, { scope, trigger: "optional" });
    for (const id of ids) await link(modifier.id, id);
  };

/** Insert an active opt-in add-on scoped to the given listing ids. */
export const optInAddOnForListings = addOnScopedTo(
  "listings",
  linkModifierListing,
);

/** Insert an active opt-in add-on scoped to the given group ids. */
export const groupScopedAddOn = addOnScopedTo("groups", linkModifierGroup);
