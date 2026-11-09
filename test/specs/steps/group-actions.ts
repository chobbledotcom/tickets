import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER, openAdminPage } from "#test/specs/support/browser.ts";
import {
  findOrCreateGroup,
  groupActionPath,
  groupActionsPath,
  groupNamed,
} from "#test/specs/support/groups.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";

/** The group whose Actions tab was opened, so the `Then` steps can build
 *  the action-link hrefs from its id rather than parsing the browser URL. */
const actionsGroup = new WeakMap<TicketsWorld, string>();

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
  "the organiser opens the actions page for the {string} group",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    const group = await groupNamed(groupName);
    const browser = await openAdminPage(this, groupActionsPath(group.id));
    this.things.remember("browser", ORGANISER, browser);
    actionsGroup.set(this, groupName);
  },
);

const assertOffered = async (
  world: TicketsWorld,
  action: "duplicate" | "deactivate" | "reactivate",
  expected: boolean,
): Promise<void> => {
  const groupName = actionsGroup.get(world);
  if (!groupName) throw new Error("No group Actions tab was opened");
  const group = await groupNamed(groupName);
  const browser = world.things.require("browser", ORGANISER);
  const href = groupActionPath(action)(group.id);
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
