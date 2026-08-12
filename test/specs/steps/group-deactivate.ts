// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { groups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { adminBrowser, ORGANISER } from "#test/specs/support/browser.ts";
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

/** The listing names each group was set up with, recorded at Given time so the
 * `Then` steps assert on the exact listing ids the story created — not a
 * post-action membership re-query that could silently drop a listing whose
 * `group_listings` row a regression deleted alongside flipping `active`. */
const groupMembers = new WeakMap<TicketsWorld, Map<string, string[]>>();

/** Record that a listing belongs to a group, at Given time. */
const rememberGroupMember = (
  world: TicketsWorld,
  groupName: string,
  listingName: string,
): void => {
  let members = groupMembers.get(world);
  if (!members) {
    members = new Map();
    groupMembers.set(world, members);
  }
  const names = members.get(groupName) ?? [];
  names.push(listingName);
  members.set(groupName, names);
};

/** The listing names a Given step set up under this group. Throws if none were
 * recorded — so a `Then` that references a group the story never set up fails
 * rather than passing vacuously. */
const memberNamesOfGroup = (
  world: TicketsWorld,
  groupName: string,
): string[] => {
  const names = groupMembers.get(world)?.get(groupName);
  if (!names || names.length === 0) {
    throw new Error(`No listings were set up for the "${groupName}" group`);
  }
  return names;
};

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
    rememberGroupMember(this, groupName, memberName);
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
 * one lands on the group's page. The form's pre-submission page text is also
 * kept, so a `Then` can assert the rendered impact count before the send. */
const organiserDeactivatesGroup = async (
  world: TicketsWorld,
  groupName: string,
  typed: string,
): Promise<TestBrowser> => {
  const group = await groupNamed(groupName);
  const browser = await adminBrowser(world);
  await browser.visit(DEACTIVATE_PATH(group.id));
  world.things.remember("told", `${ORGANISER} form`, browser.pageText);
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    deactivateButton(),
  );
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
  return browser;
};

/** A confirmed deactivation — the organiser types the group's own name. The
 * browser is kept so a following `Then` can assert where the site sent them —
 * a regression that updates the rows but fails to render the success page
 * would pass a DB-only check. */
When(
  "the organiser takes the {string} group off sale, typing its name to confirm",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    const browser = await organiserDeactivatesGroup(this, groupName, groupName);
    this.things.remember("browser", ORGANISER, browser);
  },
);

/** A refused deactivation — the organiser types the wrong name. The browser is
 * kept so a following `Then` can assert the site left them on the retry form. */
When(
  "the organiser tries to take the {string} group off sale, typing {string} instead",
  async function (
    this: TicketsWorld,
    groupName: string,
    typed: string,
  ): Promise<void> {
    const browser = await organiserDeactivatesGroup(this, groupName, typed);
    this.things.remember("browser", ORGANISER, browser);
  },
);

/** The `active` flag is what deactivation flips, and there is no user-facing
 * form that surfaces it as a rendered claim — so a direct read is the right way
 * to check it (per E2E_TESTS.md: "pure data-in/data-out rules with no
 * user-facing form action may read state directly"). Asserts on the exact
 * listing ids the Given step created for the group, so a regression that
 * deleted a `group_listings` row while flipping `active` cannot silently drop
 * that listing from the assertion set. */
const assertActive = async (
  listingIds: number[],
  expected: boolean,
): Promise<void> => {
  expect(listingIds.length).toBeGreaterThan(0);
  for (const id of listingIds) {
    expect((await getListingWithCount(id))?.active).toBe(expected);
  }
};

/** The listing ids a Given step set up as members of the named group. Used
 * directly — not re-queried from `group_listings` — so the assertion checks
 * exactly the listings the story created, even if a post-action bug removed a
 * membership row. */
const memberIdsOfGroup = (world: TicketsWorld, groupName: string): number[] =>
  memberNamesOfGroup(world, groupName).map(
    (name) => listingNamed(world, name).id,
  );

/** The listing ids a Given step set up that are NOT in the named group —
 * including ungrouped ones, which have no group membership recorded. */
const outsiderIdsOf = (world: TicketsWorld, groupName: string): number[] => {
  const inGroup = new Set(memberNamesOfGroup(world, groupName));
  return world.things
    .names("listing")
    .filter((name) => !inGroup.has(name))
    .map((name) => listingNamed(world, name).id);
};

Then(
  "the organiser is told the group name does not match",
  function (this: TicketsWorld): void {
    // Assert the reason the site gave, not merely that it refused — a 500
    // or a redirect to login would also leave the page with words on it.
    expect(this.things.require("told", ORGANISER)).toContain("does not match");
  },
);

/** Assert the organiser's browser landed on the expected path for the named
 * group. Shared by the success-redirect and wrong-name-retry `Then` steps so
 * the URL-check logic is not duplicated (jscpd 0% gate). */
const assertOnGroupPath = async (
  world: TicketsWorld,
  groupName: string,
  pathFor: (groupId: number) => string,
): Promise<void> => {
  const group = await groupNamed(groupName);
  const browser = world.things.require("browser", ORGANISER);
  expect(browser.currentUrl).toBe(pathFor(group.id));
};

/** After a confirmed deactivation the site redirects to the group's own page
 * with a flash message — so a regression that updates the rows but fails
 * before the final redirect (leaving the organiser on a broken page) is
 * caught here, not just by the DB-only `active` flag check. */
Then(
  "the organiser is sent to the {string} group's page",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertOnGroupPath(this, groupName, (id) => `/admin/groups/${id}`);
  },
);

Then(
  "every listing in the {string} group is off sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(memberIdsOfGroup(this, groupName), false);
  },
);

Then(
  "every listing in the {string} group is still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(memberIdsOfGroup(this, groupName), true);
  },
);

Then(
  "listings outside the {string} group are still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(outsiderIdsOf(this, groupName), true);
  },
);

/** The deactivate confirmation page renders an impact count — "deactivate N
 * active listing(s)" — so the organiser knows what they are about to do. A
 * regression that omits or wrongly pluralizes this copy would no longer fail
 * any test; this step reads the pre-submission form text captured when the
 * organiser opened the page. */
Then(
  "the confirmation form says it will deactivate {int} active listings",
  function (this: TicketsWorld, count: number): void {
    const formText = this.things.require("told", `${ORGANISER} form`);
    const noun = count === 1 ? "listing" : "listings";
    expect(formText).toContain(`deactivate ${count} active ${noun}`);
  },
);

/** A wrong name should leave the organiser on the retry form (the deactivate
 * path), not redirect them away while carrying the error text. Asserting the
 * flash message alone would miss a regression that sends them elsewhere. */
Then(
  "the organiser is still on the {string} group's deactivate form",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertOnGroupPath(this, groupName, DEACTIVATE_PATH);
  },
);
