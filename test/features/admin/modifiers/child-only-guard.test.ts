import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  modifierGroups,
  modifierListings,
  modifiersTable,
} from "#shared/db/modifiers.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  insertModifier,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";
import { makeParent } from "#test-utils/parents.ts";
import { adminFormPost, getTestSession } from "#test-utils/session.ts";
import { createData, lastModifier } from "./helpers.ts";

describeWithEnv(
  "server (admin modifiers) > child-only add-on guard",
  { db: true },
  () => {
    /** An active opt-in, listings-scoped add-on with no links yet. */
    const optInAddOn = async (name: string) => {
      const modifier = await insertModifier({ name });
      await patchModifier(modifier.id, {
        active: 1,
        scope: "listings",
        trigger: "optional",
      });
      return modifier;
    };

    /** A bookable_alone child with the "Solo extra" opt-in add-on linked to it. */
    const linkSoloAddOnToBookableAloneChild = async () => {
      const { child } = await makeParent({
        children: [{ bookableAlone: true, name: "Solo Widget" }],
      });
      const modifier = await optInAddOn("Solo extra");
      await adminFormPost(`/admin/modifiers/${modifier.id}/links`, {
        listing_ids: String(child.id),
      });
      return { child, modifier };
    };

    /** POST a child link and assert the scope save succeeded and stuck. */
    const expectChildLinkSaved = async (
      modifierId: number,
      childId: number,
    ) => {
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifierId}/links`,
        { listing_ids: String(childId) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifierId}/edit`,
        "Scope updated",
        true,
      )(response);
      expect(await modifierListings.getIds(modifierId)).toEqual([childId]);
    };

    test("allows creating a whole-order opt-in add-on (reachable everywhere)", async () => {
      // A whole-order (scope "all") add-on loads on every page, so it can never
      // be a child-only dead end — creating one with the flag on is allowed.
      const { response } = await adminFormPost(
        "/admin/modifiers",
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Order extra",
          trigger: "optional",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier created",
        true,
      )(response);
      expect((await lastModifier()).trigger).toBe("optional");
    });

    test("blocks scoping an opt-in add-on to only a child via the links form", async () => {
      const { child } = await makeParent();
      const modifier = await optInAddOn("Child-only extra");
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { listing_ids: String(child.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Child-only extra" }),
        false,
      )(response);
      expect(await modifierListings.getIds(modifier.id)).toEqual([]);
    });

    test("ALLOWS scoping an opt-in add-on to only a bookable_alone child", async () => {
      // A `bookable_alone` child serves its own booking page, so an add-on
      // scoped to it alone is reachable (not a dead end) — the two-sided
      // reachability counts the flagged child as a live page.
      const { child, modifier } = await linkSoloAddOnToBookableAloneChild();
      // The link stuck — no child-only dead-end block fired.
      expect(await modifierListings.getIds(modifier.id)).toEqual([child.id]);
    });

    test("clearing bookable_alone re-blocks when it orphans the child's add-on", async () => {
      // The child's own page is the ONLY thing rescuing the add-on. Clearing the
      // flag would strip that page and dead-end the add-on, so the listing save
      // is rejected (the false-transition guard) and the flag stays true.
      const { child } = await linkSoloAddOnToBookableAloneChild();
      // The edit endpoint 400s (non-302), so the helper throws; the flag is kept.
      await expect(
        updateTestListing(child.id, { bookableAlone: false }),
      ).rejects.toThrow();
      const { getListingWithCount } = await import(
        "#shared/db/listings/records.ts"
      );
      expect((await getListingWithCount(child.id))!.bookable_alone).toBe(true);
    });

    test("blocks flipping a child-scoped modifier to an opt-in add-on on edit", async () => {
      const { child } = await makeParent();
      const modifier = await insertModifier({ name: "Becomes add-on" });
      await patchModifier(modifier.id, { scope: "listings" });
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Becomes add-on",
          scope: "listings",
          trigger: "optional",
        }),
      );
      await expectHtmlResponse(
        response,
        400,
        t("modifiers.err_child_only_addon", { name: "Becomes add-on" }),
        'value="optional" selected',
        'value="Becomes add-on"',
      );
      expect(
        (await modifiersTable.read.one({ id: modifier.id }))!.trigger,
      ).toBe("automatic");
    });

    test("allows editing an active NON-opt-in child-scoped modifier (not an add-on)", async () => {
      // The child-only-dead-end check applies only to opt-in add-ons: an active
      // automatic modifier scoped solely to a child is never offered on a page,
      // so a plain resource edit (here, a name change) must NOT be blocked even
      // though its stored scope is child-only.
      const { child } = await makeParent();
      const modifier = await insertModifier({ name: "Auto child surcharge" });
      await patchModifier(modifier.id, { active: 1, scope: "listings" });
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          active: "1",
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Auto child surcharge renamed",
          scope: "listings",
          trigger: "automatic",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      expect((await modifiersTable.read.one({ id: modifier.id }))!.name).toBe(
        "Auto child surcharge renamed",
      );
    });

    test("allows flipping a {child, parent}-scoped modifier to an opt-in add-on", async () => {
      const { parent, child } = await makeParent();
      const modifier = await insertModifier({ name: "Shared add-on" });
      await patchModifier(modifier.id, { scope: "listings" });
      // Scoped to both the parent (a reachable page) and the child: not a dead
      // end, so flipping it to an opt-in add-on is allowed.
      await linkModifierListing(modifier.id, parent.id);
      await linkModifierListing(modifier.id, child.id);
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/edit`,
        createData({
          calc_kind: "fixed",
          calc_value: "5",
          direction: "charge",
          name: "Shared add-on",
          scope: "listings",
          trigger: "optional",
        }),
      );
      await expectFlashRedirect(
        "/admin/modifiers",
        "Modifier updated",
        true,
      )(response);
      expect(
        (await modifiersTable.read.one({ id: modifier.id }))!.trigger,
      ).toBe("optional");
    });

    test("blocks scoping an opt-in add-on to a group of only children", async () => {
      const group = await createTestGroup({ name: "Add-ons" });
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      const modifier = await insertModifier({ name: "Group child extra" });
      await patchModifier(modifier.id, {
        active: 1,
        scope: "groups",
        trigger: "optional",
      });
      const { response } = await adminFormPost(
        `/admin/modifiers/${modifier.id}/links`,
        { group_ids: String(group.id) },
      );
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Group child extra" }),
        false,
      )(response);
      expect(await modifierGroups.getIds(modifier.id)).toEqual([]);
    });

    test("allows scoping a non-opt-in modifier to only a child (not an add-on)", async () => {
      const { child } = await makeParent();
      // An automatic surcharge is never offered as an opt-in add-on, so it can
      // be scoped to a child without dead-ending.
      const modifier = await insertModifier({ name: "Auto surcharge" });
      await patchModifier(modifier.id, { active: 1, scope: "listings" });
      await expectChildLinkSaved(modifier.id, child.id);
    });

    test("allows an inactive child-scoped opt-in add-on (never loads on a page)", async () => {
      const { child } = await makeParent();
      const modifier = await insertModifier({ name: "Inactive extra" });
      // An inactive *opt-in* add-on: the trigger would dead-end if it were
      // active, but an inactive modifier never loads, so the save is allowed.
      await patchModifier(modifier.id, {
        active: 0,
        scope: "listings",
        trigger: "optional",
      });
      await expectChildLinkSaved(modifier.id, child.id);
    });

    /** POST the scope-links form with repeated `listing_ids` values
     * (mockFormRequest only carries a single value per key). */
    const postListingLinks = async (
      modifierId: number,
      listingIds: number[],
    ): Promise<Response> => {
      const { cookie, csrfToken } = await getTestSession();
      const body = new URLSearchParams();
      body.set("csrf_token", csrfToken);
      for (const id of listingIds) body.append("listing_ids", String(id));
      return handleRequest(
        new Request(`http://localhost/admin/modifiers/${modifierId}/links`, {
          body: body.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            host: "localhost",
          },
          method: "POST",
        }),
      );
    };

    test("blocks scoping an opt-in add-on to {child, inactive non-child}", async () => {
      // The non-child listing is INACTIVE, so it serves no public booking page
      // and can't load the add-on. The add-on is therefore reachable only via
      // the suppressed child — still a dead end, so the save is blocked.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const inactive = await createTestListing({ name: "Hidden extra page" });
      await deactivateTestListing(inactive.id);
      await listingChildren.setIds(parent.id, [child.id]);
      const modifier = await optInAddOn("Stranded extra");
      const response = await postListingLinks(modifier.id, [
        child.id,
        inactive.id,
      ]);
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.err_child_only_addon", { name: "Stranded extra" }),
        false,
      )(response);
      expect(await modifierListings.getIds(modifier.id)).toEqual([]);
    });

    test("allows scoping an opt-in add-on to {child, active non-child}", async () => {
      // The non-child listing is ACTIVE, so its booking page loads the add-on:
      // not a dead end, so the save is allowed.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const reachable = await createTestListing({ name: "Live extra page" });
      await listingChildren.setIds(parent.id, [child.id]);
      const modifier = await optInAddOn("Reachable extra");
      const response = await postListingLinks(modifier.id, [
        child.id,
        reachable.id,
      ]);
      await expectFlashRedirect(
        `/admin/modifiers/${modifier.id}/edit`,
        "Scope updated",
        true,
      )(response);
      expect(await modifierListings.getIds(modifier.id)).toEqual(
        [child.id, reachable.id].sort((a, b) => a - b),
      );
    });
  },
);
