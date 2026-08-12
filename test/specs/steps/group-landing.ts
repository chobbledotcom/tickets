// deno-fmt-ignore-file

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER, openAdminPage } from "#test/specs/support/browser.ts";
import {
  bulkActionPath,
  findOrCreateGroup,
  groupNamed,
} from "#test/specs/support/groups.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";

const LANDING_PATH = bulkActionPath("");

/** The group whose landing page was opened, so the `Then` steps can build
 *  the action-link hrefs from its id rather than parsing the browser URL. */
const landingGroup = new WeakMap<TicketsWorld, string>();

const actionLinkHref = (
  groupId: number,
  action: "duplicate" | "deactivate" | "reactivate",
): string => `/admin/groups/${groupId}/bulk-actions/${action}`;

Given(
  "the site has a group called {string} with no listings",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await findOrCreateGroup(groupName);
  },
);

Given(
  "{string} is taken off sale",
  async function (this: TicketsWorld, listingName: string): Promise<void> {
    await deactivateTestListing(listingNamed(this, listingName).id);
  },
);

When(
  "the organiser opens the bulk actions page for the {string} group",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    const group = await groupNamed(groupName);
    const browser = await openAdminPage(this, LANDING_PATH(group.id));
    this.things.remember("browser", ORGANISER, browser);
    landingGroup.set(this, groupName);
  },
);

const assertOffered = async (
  world: TicketsWorld,
  action: "duplicate" | "deactivate" | "reactivate",
  expected: boolean,
): Promise<void> => {
  const groupName = landingGroup.get(world);
  if (!groupName) throw new Error("No bulk-actions page was opened");
  const group = await groupNamed(groupName);
  const browser = world.things.require("browser", ORGANISER);
  const href = actionLinkHref(group.id, action);
  expect(browser.links.some((l) => l.href === href)).toBe(expected);
};

Then(
  "the organiser is offered a way to copy the group",
  async function (this: TicketsWorld): Promise<void> {
    await assertOffered(this, "duplicate", true);
  },
);

Then(
  "the organiser is offered a way to take the group off sale",
  async function (this: TicketsWorld): Promise<void> {
    await assertOffered(this, "deactivate", true);
  },
);

Then(
  "the organiser is offered a way to bring the group back on sale",
  async function (this: TicketsWorld): Promise<void> {
    await assertOffered(this, "reactivate", true);
  },
);

Then(
  "the organiser is not offered a way to take the group off sale",
  async function (this: TicketsWorld): Promise<void> {
    await assertOffered(this, "deactivate", false);
  },
);

Then(
  "the organiser is not offered a way to bring the group back on sale",
  async function (this: TicketsWorld): Promise<void> {
    await assertOffered(this, "reactivate", false);
  },
);

/** The landing page renders "Apply an operation across all N listing(s) in
 *  <b>Group</b>." The count noun is singular for 1 and plural otherwise.
 *  Because "1 listing" is a substring of "1 listings", a regex with `(?!s)`
 *  guards the singular against the plural slipping through. */
Then(
  "the page says it holds {int} listing(s)",
  function (this: TicketsWorld, count: number): void {
    const browser = this.things.require("browser", ORGANISER);
    const phrase = count === 1 ? "all 1 listing(?!s)" : `all ${count} listings`;
    expect(new RegExp(phrase).test(browser.pageText)).toBe(true);
  },
);
