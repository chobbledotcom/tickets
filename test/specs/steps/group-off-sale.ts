// deno-fmt-ignore-file
// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import {
  keepsWhatTheOrganiserSaw,
  ORGANISER,
  openAdminPage,
} from "#test/specs/support/browser.ts";
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
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

/** The confirmation form's page text, captured before the submit button is
 * sent, so a `Then` can assert the rendered impact count. `TestBrowser.
 * pageText` changes to the post-submission result page after `fillInAndSend`,
 * so the pre-submission snapshot must be kept separately. */
const formSnapshots = new WeakMap<TicketsWorld, string>();

/** One direction of the on/off-sale switch: where its confirmation form
 * lives, and the button that sends it. The button label is looked up at call
 * time, because the catalog is not loaded at module-import time. */
type SaleSwitch = { path: (groupId: number) => string; button: () => string };

const OFF_SALE: SaleSwitch = {
  button: () => t("bulk_actions.deactivate_confirm_button"),
  path: bulkActionPath("deactivate"),
};

const BACK_ON_SALE: SaleSwitch = {
  button: () => t("bulk_actions.reactivate_confirm_button"),
  path: bulkActionPath("reactivate"),
};

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

/** The organiser opens one direction's confirmation form, types a name, and
 * sends it. Both directions differ only in which form and which button, so
 * the journey is written once and curried on the switch. */
const organiserSwitchesGroup =
  (theSwitch: SaleSwitch) =>
  async (
    world: TicketsWorld,
    groupName: string,
    typed: string,
  ): Promise<void> => {
    const group = await groupNamed(groupName);
    const browser = await openAdminPage(world, theSwitch.path(group.id));
    formSnapshots.set(world, browser.pageText);
    world.things.remember("browser", ORGANISER, browser);
    await fillInAndSend(
      browser,
      { confirm_identifier: typed },
      theSwitch.button(),
    );
    keepsWhatTheOrganiserSaw(world, browser);
  };

const organiserDeactivatesGroup = organiserSwitchesGroup(OFF_SALE);
const organiserReactivatesGroup = organiserSwitchesGroup(BACK_ON_SALE);

type SwitchesAGroup = ReturnType<typeof organiserSwitchesGroup>;

/** The confirm case: the organiser types the group's own name. */
const typingItsName = (switches: SwitchesAGroup) =>
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await switches(this, groupName, groupName);
  };

/** The wrong-name case: the organiser types something else. Registered as a
 * separate two-parameter step function because Cucumber binds arguments by
 * position — a shared function with an optional parameter would mis-bind. */
const typingInstead = (switches: SwitchesAGroup) =>
  async function (
    this: TicketsWorld,
    groupName: string,
    typed: string,
  ): Promise<void> {
    await switches(this, groupName, typed);
  };

When(
  "the organiser takes the {string} group off sale, typing its name to confirm",
  typingItsName(organiserDeactivatesGroup),
);

When(
  "the organiser tries to take the {string} group off sale, typing {string} instead",
  typingInstead(organiserDeactivatesGroup),
);

Given(
  "the organiser has taken the {string} group off sale",
  typingItsName(organiserDeactivatesGroup),
);

When(
  "the organiser brings the {string} group back on sale, typing its name to confirm",
  typingItsName(organiserReactivatesGroup),
);

When(
  "the organiser tries to bring the {string} group back on sale, typing {string} instead",
  typingInstead(organiserReactivatesGroup),
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

/** Whether every listing the story put in the group is on sale, told from
 * the exact ids the Given steps recorded. */
const everyMemberIs = (onSale: boolean) =>
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(memberIdsOf(this, groupName), onSale);
  };

Then("every listing in the {string} group is off sale", everyMemberIs(false));

Then(
  "every listing in the {string} group is still off sale",
  everyMemberIs(false),
);

Then(
  "every listing in the {string} group is still on sale",
  everyMemberIs(true),
);

Then(
  "every listing in the {string} group is back on sale",
  everyMemberIs(true),
);

Then(
  "listings outside the {string} group are still on sale",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertActive(outsiderIdsOf(this, groupName), true);
  },
);

/** The confirmation form renders an impact count — "deactivate N active
 * listing(s)" / "reactivate N listing(s)". Because the singular is a
 * substring of the plural, a regex with `(?!s)` is used for count = 1. */
const confirmFormSaysItWill = (verb: string, noun: string) =>
  function (this: TicketsWorld, count: number): void {
    const formText = formSnapshots.get(this);
    if (!formText) throw new Error("No form snapshot was captured");
    const tail = count === 1 ? "(?!s)" : "s";
    expect(new RegExp(`${verb} ${count} ${noun}${tail}`).test(formText)).toBe(
      true,
    );
  };

Then(
  "the confirmation form says it will deactivate {int} active listing\\(s\\)",
  confirmFormSaysItWill("deactivate", "active listing"),
);

Then(
  "the confirmation form says it will reactivate {int} listing\\(s\\)",
  confirmFormSaysItWill("reactivate", "listing"),
);

/** Still on one direction's confirmation form, so the organiser can try the
 * name again. */
const stillOnItsForm = (theSwitch: SaleSwitch) =>
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await assertOnGroupPath(this, groupName, theSwitch.path);
  };

Then(
  "the organiser is still on the {string} group's deactivate form",
  stillOnItsForm(OFF_SALE),
);

Then(
  "the organiser is still on the {string} group's reactivate form",
  stillOnItsForm(BACK_ON_SALE),
);
