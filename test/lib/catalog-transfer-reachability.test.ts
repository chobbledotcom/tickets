import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { assignListingsToGroup } from "#shared/db/groups.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  insertModifier,
  linkModifierGroup,
  patchModifier,
} from "#test-utils";

// Child add-on reachability on import lives in its own file: the setup creates
// listings, a group, and an opt-in modifier, and folding it into
// catalog-transfer.test.ts would tip that file's per-request read count past
// the N+1 guard.

/** Create an active, group-scoped opt-in add-on covering `groupId`. */
const groupOptInAddOn = async (
  name: string,
  groupId: number,
): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, { scope: "groups", trigger: "optional" });
  await linkModifierGroup(modifier.id, groupId);
};

describeWithEnv(
  "catalog-transfer child add-on reachability",
  { db: true },
  () => {
    test("rejects a child import that orphans a group-scoped add-on", async () => {
      // The add-on is scoped to a group whose only would-be member is the imported
      // child. A child has no standalone page, and its parent isn't in the group,
      // so the add-on would be reachable only through the suppressed child — the
      // dead-end the edge editor rejects.
      const group = await createTestGroup({ name: "Extra Group" });
      await createTestListing({ name: "Base Parent" });
      await groupOptInAddOn("Group Extra", group.id);

      const result = await importCatalog({
        groups: [{ group: "Extra Group" }],
        kind: "listing",
        listing: { maxAttendees: 1, name: "Orphan Kid" },
        parents: ["Base Parent"],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // The edge editor's own child-add-on message (its {addon}/{name}
      // placeholders are quote-escaped in the locale, so assert its stable prose).
      expect(result.error).toContain("opt-in add-on");
      expect(result.error).toContain("offering it as a child");
    });

    test("accepts a child import when the parent's page also reaches the add-on", async () => {
      // The parent is in the same group, so the group-scoped add-on reaches the
      // parent's own booking page — not a dead end.
      const group = await createTestGroup({ name: "Shared Group" });
      const parent = await createTestListing({ name: "Shared Parent" });
      await assignListingsToGroup([parent.id], group.id);
      await groupOptInAddOn("Shared Extra", group.id);

      const result = await importCatalog({
        groups: [{ group: "Shared Group" }],
        kind: "listing",
        listing: { maxAttendees: 1, name: "Fine Kid" },
        parents: ["Shared Parent"],
        version: 1,
      });
      if (!result.ok) throw new Error(result.error);
    });
  },
);
