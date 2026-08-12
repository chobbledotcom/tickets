// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { getListingsByGroupId, groups } from "#shared/db/groups.ts";
import { ORGANISER, openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { rememberListing } from "#test/specs/support/listings.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The form the organiser fills in to copy a group, by the path the site gave
 * it. Read off the served page rather than constructed, so a duplicate form that
 * stopped rendering any field fails here instead of the send going through. */
const DUPLICATE_PATH = (groupId: number): string =>
  `/admin/groups/${groupId}/bulk-actions/duplicate`;

/** The submit button the duplicate form carries — the production i18n key, not
 * a copied wording, so a rename in the catalog reaches the story too. Looked up
 * at call time, because the catalog is not loaded at module-import time. */
const duplicateButton = (): string => t("bulk_actions.submit_duplicate");

/** A group the story is talking about, kept under the name the story calls it.
 * Searches the live group set rather than remembering an id at set-up, because a
 * later step may have taken a group away and the story still needs to find the
 * one it has now — not one an earlier step held onto. */
const groupNamed = async (name: string) => {
  const all = await groups.cache.getAll();
  const found = all.find((g) => g.name === name);
  if (!found) throw new Error(`No group called "${name}" exists`);
  return found;
};

/** Set up a group with one member, both remembered by the names the story uses.
 * The member's date is what the form will shift; storing the listing under its
 * name lets the story read it back through that name after the copy. */
Given(
  "the site has a group called {string} with {string} starting on {string}",
  async function (
    this: TicketsWorld,
    groupName: string,
    memberName: string,
    date: string,
  ): Promise<void> {
    const group = await createTestGroup({ name: groupName });
    rememberListing(
      this,
      memberName,
      await createTestListing({
        date: `${date}T09:00`,
        groupId: group.id,
        name: memberName,
      }),
    );
  },
);

/** The site already has a group with one member; their exact stored date is the
 * story's own concern rather than something the form drives. */
Given(
  "the site has a group called {string} with {string} in it",
  async function (
    this: TicketsWorld,
    groupName: string,
    memberName: string,
  ): Promise<void> {
    const group = await createTestGroup({ name: groupName });
    rememberListing(
      this,
      memberName,
      await createTestListing({
        date: "2026-06-01T09:00",
        groupId: group.id,
        name: memberName,
      }),
    );
  },
);

/** The path the organiser's own list of groups is on. */
const GROUPS_LIST_PATH = "/admin/groups";

/** The organiser opens the duplicate form for one group, fills it in from what
 * the page offers, and sends it. What the site told them afterwards is kept
 * under the organiser's name — the same place every "the organiser is told …"
 * step reads from — because a refused copy lands back on the form with words on
 * it, and a successful one lands on the new group's page. */
const organiserDuplicatesGroup = async (
  world: TicketsWorld,
  sourceName: string,
  fillsIn: Record<string, string>,
): Promise<TestBrowser> => {
  const source = await groupNamed(sourceName);
  const browser = await openAdminPage(world, DUPLICATE_PATH(source.id));
  await fillInAndSend(browser, fillsIn, duplicateButton());
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
  return browser;
};

/** A copy that shifts the name and the date. The form gives every field, so the
 * story sends them all — leaving any out is its own step, not a default this one
 * fills in. */
When(
  "the organiser copies the {string} group as {string}, renaming {string} to {string} and shifting the date from {string} to {string}",
  async function (
    this: TicketsWorld,
    source: string,
    newName: string,
    find: string,
    replace: string,
    dateFind: string,
    dateReplace: string,
  ): Promise<void> {
    await organiserDuplicatesGroup(this, source, {
      date_find: dateFind,
      date_replace: dateReplace,
      name_find: find,
      name_replace: replace,
      new_name: newName,
    });
  },
);

/** A copy that renames the members but does not shift their dates. The date
 * fields are sent empty, which the form treats as "leave each date as it was". */
When(
  "the organiser copies the {string} group as {string}, renaming {string} to {string}",
  async function (
    this: TicketsWorld,
    source: string,
    newName: string,
    find: string,
    replace: string,
  ): Promise<void> {
    await organiserDuplicatesGroup(this, source, {
      date_find: "",
      date_replace: "",
      name_find: find,
      name_replace: replace,
      new_name: newName,
    });
  },
);

/** A copy with no name replacement at all — the form's find/replace fields stay
 * blank, so each member keeps its name. Names are unique across the site, which
 * is what this scenario is about to find out. */
When(
  "the organiser copies the {string} group as {string} with no name replacement",
  async function (
    this: TicketsWorld,
    source: string,
    newName: string,
  ): Promise<void> {
    await organiserDuplicatesGroup(this, source, {
      date_find: "",
      date_replace: "",
      name_find: "",
      name_replace: "",
      new_name: newName,
    });
  },
);

/** The words the site last told the organiser — what a refused form landed on,
 * captured the moment the send came back. */
const whatOrganiserWasTold = (world: TicketsWorld): string =>
  world.things.require("told", ORGANISER);

Then(
  "the organiser is told a member would keep a name already taken",
  function (this: TicketsWorld): void {
    // The production message names the collision; assert the reason the site
    // gave, not merely that it refused — a 500 or a redirect to login would
    // also leave the page with words on it.
    expect(whatOrganiserWasTold(this)).toContain("already exists");
  },
);

/** A group is offered on the organiser's list when its name is the link text of
 * a row — reading the rendered page, not the store, so a list that stopped
 * showing a group fails here rather than the story reporting one nobody can see. */
Then(
  "the organiser's list offers the {string} group",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openAdminPage(this, GROUPS_LIST_PATH);
    expect(browser.pageText).toContain(name);
  },
);

Then(
  "the organiser's list does not offer the {string} group",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await openAdminPage(this, GROUPS_LIST_PATH);
    expect(browser.pageText).not.toContain(name);
  },
);

/** The day a member's stored date falls on, as `YYYY-MM-DD`. The form preserves
 * the time-of-day across a shift, so the day alone is what the story compares —
 * matching the direct test, which uses the same day-offset arithmetic. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/** One group's members, kept in the store, read back by the story's name for
 * the group. Used for the count and the per-member reads, because there is no
 * user-facing form action the "one member called X" assertion could drive. */
const membersOf = async (groupName: string) => {
  const group = await groupNamed(groupName);
  return getListingsByGroupId(group.id);
};

/** The group has exactly one member, it is the named one, and it falls on the
 * given day. Both the new copy and the original are checked the same way: a
 * copy that landed a second member, or whose member was renamed, or whose date
 * did not shift as the story said, fails here. */
const assertOneMemberOn = async (
  groupName: string,
  memberName: string,
  day: string,
): Promise<void> => {
  const members = await membersOf(groupName);
  expect(members).toHaveLength(1);
  const member = members[0]!;
  expect(member.name).toBe(memberName);
  expect(dayOf(member.date)).toBe(day);
};

Then(
  "the {string} group has one member called {string}, starting on {string}",
  async function (
    this: TicketsWorld,
    groupName: string,
    memberName: string,
    day: string,
  ): Promise<void> {
    await assertOneMemberOn(groupName, memberName, day);
  },
);

/** The original group is asserted with the same check as the copy: it kept its
 * one member, named and dated as the story left it. Sharing the helper keeps the
 * two `Then`s from drifting on what "still has" actually proves. */
Then(
  "the original {string} group still has {string} starting on {string}",
  async function (
    this: TicketsWorld,
    groupName: string,
    memberName: string,
    day: string,
  ): Promise<void> {
    await assertOneMemberOn(groupName, memberName, day);
  },
);

Then(
  "the {string} group still has exactly one member",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    expect((await membersOf(groupName)).length).toBe(1);
  },
);
