// deno-fmt-ignore-file
// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { ORGANISER, openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  bulkActionPath,
  findOrCreateGroup,
  groupNamed,
  memberIdsOf,
  memberNamesOf,
  rememberGroupMember,
} from "#test/specs/support/groups.ts";
import { listingNamed, rememberListing } from "#test/specs/support/listings.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

/** The deactivate form's page text, captured before the submit button is sent,
 * so a `Then` can assert the rendered impact count. `TestBrowser.pageText`
 * changes to the post-submission result page after `fillInAndSend`, so the
 * pre-submission snapshot must be kept separately. */
const formSnapshots = new WeakMap<TicketsWorld, string>();

const DEACTIVATE_PATH = bulkActionPath("deactivate");

const deactivateButton = (): string =>
  t("bulk_actions.deactivate_confirm_button");

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

const organiserDeactivatesGroup = async (
  world: TicketsWorld,
  groupName: string,
  typed: string,
): Promise<void> => {
  const group = await groupNamed(groupName);
  const browser = await openAdminPage(world, DEACTIVATE_PATH(group.id));
  formSnapshots.set(world, browser.pageText);
  world.things.remember("browser", ORGANISER, browser);
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    deactivateButton(),
  );
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
};

When(
  "the organiser takes the {string} group off sale, typing its name to confirm",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await organiserDeactivatesGroup(this, groupName, groupName);
  },
);

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

/** The `active` flag has no user-facing form claim, so a direct read is the
 * right way to check it (per E2E_TESTS.md). Asserts on the exact listing ids
 * the Given step created — not a post-action membership re-query. */
const assertActive = async (
  listingIds: number[],
  expected: boolean,
): Promise<void> => {
  expect(listingIds.length).toBeGreaterThan(0);
  for (const id of listingIds) {
    expect((await getListingWithCount(id))?.active).toBe(expected);
  }
};

const outsiderIdsOf = (world: TicketsWorld, groupName: string): number[] => {
  const inGroup = new Set(memberNamesOf(world, groupName));
  return world.things
    .names("listing")
    .filter((name) => !inGroup.has(name))
    .map((name) => listingNamed(world, name).id);
};

Then(
  "the organiser is told the group name does not match",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      "Group name does not match",
    );
  },
);

const assertOnGroupPath = async (
  world: TicketsWorld,
  groupName: string,
  pathFor: (groupId: number) => string,
): Promise<void> => {
  const group = await groupNamed(groupName);
  const browser = world.things.require("browser", ORGANISER);
  expect(browser.currentUrl).toBe(pathFor(group.id));
};

Then(
  "the organiser is sent to the {string} group's page",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertOnGroupPath(this, groupName, (id) => `/admin/groups/${id}`);
  },
);

Then(
  "every listing in the {string} group is off sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(memberIdsOf(this, groupName), false);
  },
);

Then(
  "every listing in the {string} group is still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(memberIdsOf(this, groupName), true);
  },
);

Then(
  "listings outside the {string} group are still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(outsiderIdsOf(this, groupName), true);
  },
);

/** The confirmation form renders an impact count — "deactivate N active
 * listing(s)". Because the singular is a substring of the plural, a regex
 * with `(?!s)` is used for count = 1. */
Then(
  "the confirmation form says it will deactivate {int} active listing\\(s\\)",
  function (this: TicketsWorld, count: number): void {
    const formText = formSnapshots.get(this);
    if (!formText) throw new Error("No form snapshot was captured");
    const phrase =
      count === 1
        ? "deactivate 1 active listing(?!s)"
        : `deactivate ${count} active listings`;
    expect(new RegExp(phrase).test(formText)).toBe(true);
  },
);

Then(
  "the organiser is still on the {string} group's deactivate form",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertOnGroupPath(this, groupName, DEACTIVATE_PATH);
  },
);
