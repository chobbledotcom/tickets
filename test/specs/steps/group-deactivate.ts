// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { getListingsByGroupId, groups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { ORGANISER, openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { listingNamed, rememberListing } from "#test/specs/support/listings.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The deactivate form's URL, built from the group's id. The form's
 * confirm_identifier field is read off the served page in `fillInAndSend`,
 * so a form that stopped rendering it fails there instead of the send going
 * through. */
const DEACTIVATE_PATH = (groupId: number): string =>
  `/admin/groups/${groupId}/bulk-actions/deactivate`;

/** The submit button the deactivate form carries — the production i18n key,
 * not a copied wording, so a rename in the catalog reaches the story too.
 * Looked up at call time, because the catalog is not loaded at module-import
 * time. */
const deactivateButton = (): string =>
  t("bulk_actions.deactivate_confirm_button");

/** A group the story is talking about, kept under the name the story calls it.
 * Searches the live group set rather than remembering an id at set-up, because a
 * later step may have taken a group away and the story still needs to find the
 * one it has now. */
const groupNamed = async (name: string) => {
  const all = await groups.cache.getAll();
  const found = all.find((g) => g.name === name);
  if (!found) throw new Error(`No group called "${name}" exists`);
  return found;
};

/** Find a group by name, or create it if it does not exist yet. A scenario
 * that adds a second member to the same group reuses the one already made,
 * rather than creating a duplicate (which the production create path would
 * reject). */
const findOrCreateGroup = async (name: string) => {
  const existing = (await groups.cache.getAll()).find((g) => g.name === name);
  return existing ?? (await createTestGroup({ name }));
};

/** Set up a group with one member on sale, both remembered by the names the
 * story uses. */
Given(
  "the site has a group called {string} with {string} on sale",
  async function (
    this: TicketsWorld,
    groupName: string,
    memberName: string,
  ): Promise<void> {
    const group = await findOrCreateGroup(groupName);
    rememberListing(
      this,
      memberName,
      await createTestListing({
        groupId: group.id,
        name: memberName,
      }),
    );
  },
);

/** A listing with no group, on sale. */
Given(
  "the site has a listing called {string} on sale with no group",
  async function (this: TicketsWorld, memberName: string): Promise<void> {
    rememberListing(
      this,
      memberName,
      await createTestListing({ name: memberName }),
    );
  },
);

/** The organiser opens the deactivate form for one group and sends it with the
 * name they typed. What the site told them is kept under the organiser's name —
 * the same place every "the organiser is told …" step reads from — because a
 * refused deactivation lands back on the form with words on it, and a successful
 * one lands on the group's page. */
const organiserDeactivatesGroup = async (
  world: TicketsWorld,
  groupName: string,
  typed: string,
): Promise<TestBrowser> => {
  const group = await groupNamed(groupName);
  const browser = await openAdminPage(world, DEACTIVATE_PATH(group.id));
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    deactivateButton(),
  );
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
  return browser;
};

/** A confirmed deactivation — the organiser types the group's own name. */
When(
  "the organiser takes the {string} group off sale, typing its name to confirm",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await organiserDeactivatesGroup(this, groupName, groupName);
  },
);

/** A refused deactivation — the organiser types the wrong name. */
When(
  "the organiser tries to take the {string} group off sale, typing {string} instead",
  async function (
    this: TicketsWorld,
    groupName: string,
    typed: string,
  ): Promise<void> {
    await organiserDeactivatesGroup(this, groupName, typed);
  },
);

/** The `active` flag is what deactivation flips, and there is no user-facing
 * form that surfaces it as a rendered claim — so a direct read is the right way
 * to check it (per E2E_TESTS.md: "pure data-in/data-out rules with no
 * user-facing form action may read state directly"). Asserts by the listing
 * ids the story set up, cross-referenced with the group's live member set, so
 * a regression that deleted membership rows (leaving the re-query empty)
 * cannot pass these steps vacuously. */
const assertActive = async (
  listingIds: number[],
  expected: boolean,
): Promise<void> => {
  expect(listingIds.length).toBeGreaterThan(0);
  for (const id of listingIds) {
    expect((await getListingWithCount(id))?.active).toBe(expected);
  }
};

/** Remembered listing ids that are members of the named group, cross-referenced
 * with the group's live member set. A listing that lost its membership row
 * would be missing from the live set — the `memberIdsOfGroup` call returns
 * fewer ids than expected, and the assertion catches the discrepancy through
 * the story's own remembered names. */
const memberIdsOfGroup = async (
  world: TicketsWorld,
  groupName: string,
): Promise<number[]> => {
  const target = await groupNamed(groupName);
  const liveMemberIds = new Set(
    (await getListingsByGroupId(target.id)).map((l) => l.id),
  );
  return world.things
    .names("listing")
    .map((name) => listingNamed(world, name))
    .filter((listing) => liveMemberIds.has(listing.id))
    .map((listing) => listing.id);
};

/** Remembered listing ids that are NOT in the named group — including
 * ungrouped ones. */
const outsiderIdsOf = async (
  world: TicketsWorld,
  groupName: string,
): Promise<number[]> => {
  const memberIds = new Set(await memberIdsOfGroup(world, groupName));
  return world.things
    .names("listing")
    .map((name) => listingNamed(world, name))
    .filter((listing) => !memberIds.has(listing.id))
    .map((listing) => listing.id);
};

Then(
  "the organiser is told the group name does not match",
  function (this: TicketsWorld): void {
    // Assert the reason the site gave, not merely that it refused — a 500
    // or a redirect to login would also leave the page with words on it.
    expect(this.things.require("told", ORGANISER)).toContain("does not match");
  },
);

Then(
  "every listing in the {string} group is off sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(await memberIdsOfGroup(this, groupName), false);
  },
);

Then(
  "every listing in the {string} group is still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(await memberIdsOfGroup(this, groupName), true);
  },
);

Then(
  "listings outside the {string} group are still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(await outsiderIdsOf(this, groupName), true);
  },
);
