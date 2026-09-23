/** The group's own page removing one listing from the group: the remove form
 * beside the add form, what the operator is told afterwards, and which
 * surfaces still offer the listing afterwards. */

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { t } from "#i18n";
import {
  adminPageHtmlAt,
  keepsWhatTheOrganiserSaw,
  ORGANISER,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import { expectCanReallyTick } from "#test/specs/support/form-controls/rules.ts";
import { findOrCreateGroup, groupNamed } from "#test/specs/support/groups.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { attrValue, findForms } from "#test-utils/test-browser/forms.ts";
import { regexCollect } from "#test-utils/test-browser/parsing.ts";

Given(
  "the site also has {string} in the {string} group",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
  ): Promise<void> {
    const group = await findOrCreateGroup(groupName);
    // The listing was set up for another group; it joins this one too, so
    // the story's listing sits in two groups at once.
    await assignListingsToGroup([listingNamed(this, listingName).id], group.id);
  },
);

/** The group's own record page, found by the name the story calls it. */
const groupPagePath = async (groupName: string): Promise<string> =>
  `/admin/groups/${(await groupNamed(groupName)).id}`;

/** The body of the form that removes listings from the group's page, or a
 * loud failure when the page offers none — the story must not continue past a
 * page that stopped offering the removal. */
const removeFormOn = (html: string, path: string): string => {
  const form = findForms(html).find(
    (entry) => entry.action === `${path}/remove-listings`,
  );
  if (!form) {
    throw new Error(`No remove form on ${path}`);
  }
  return form.body;
};

/** The value the form's own box for one named listing carries. The boxes are
 * read from the page the operator was served, so a listing the form stopped
 * offering cannot be removed by name alone. */
const removeBoxValue = (form: string, listingName: string): string => {
  const boxes = regexCollect(
    /<input\b[^>]*name="listing_ids"[^>]*>/gi,
    form,
    (match) => match[0],
  );
  for (const tag of boxes) {
    const boxAt = form.indexOf(tag);
    const label = form.slice(
      boxAt + tag.length,
      form.indexOf("</label>", boxAt),
    );
    if (label.includes(listingName)) {
      const value = attrValue(tag, "value");
      if (value) return value;
    }
  }
  throw new Error(`No ${listingName} box in the remove form`);
};

When(
  "the organiser removes {string} from the {string} group's page",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
  ): Promise<void> {
    const path = await groupPagePath(groupName);
    const html = await adminPageHtmlAt(this, path);
    const value = removeBoxValue(removeFormOn(html, path), listingName);
    // Ticks go through the served form's own action, so the value is checked
    // against the page before the send — the same fence every send passes.
    const browser = await withAdminPage(this, path, async (page) => {
      expectCanReallyTick(page.formBodyAt(`${path}/remove-listings`), {
        listing_ids: [value],
      });
      await page.submitFormAt(`${path}/remove-listings`, {
        listing_ids: [value],
      });
      return page;
    });
    keepsWhatTheOrganiserSaw(this, browser);
  },
);

Then(
  "the organiser is told the listings were removed from the group",
  function (this: TicketsWorld): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("success.listings_removed_from_group"),
    );
  },
);

/** Whether one of the group page's own checkbox lists still offers a listing
 * by name: the remove form when `removing` names it, the add form when
 * `adding` does. Reading the served form is what tells one list from the
 * other. */
const pageOffersListing = async (
  world: TicketsWorld,
  groupName: string,
  listingName: string,
  action: "add-listings" | "remove-listings",
): Promise<boolean> => {
  const path = await groupPagePath(groupName);
  const html = await adminPageHtmlAt(world, path);
  const form = findForms(html).find(
    (entry) => entry.action === `${path}/${action}`,
  );
  return form?.body.includes(listingName) ?? false;
};

Then(
  "the {string} group's page no longer offers {string} for removal",
  async function (
    this: TicketsWorld,
    groupName: string,
    listingName: string,
  ): Promise<void> {
    expect(
      await pageOffersListing(this, groupName, listingName, "remove-listings"),
    ).toBe(false);
  },
);

Then(
  "the {string} group's page still offers {string} for removal",
  async function (
    this: TicketsWorld,
    groupName: string,
    listingName: string,
  ): Promise<void> {
    expect(
      await pageOffersListing(this, groupName, listingName, "remove-listings"),
    ).toBe(true);
  },
);

Then(
  "the {string} group's page offers {string} for adding again",
  async function (
    this: TicketsWorld,
    groupName: string,
    listingName: string,
  ): Promise<void> {
    expect(
      await pageOffersListing(this, groupName, listingName, "add-listings"),
    ).toBe(true);
  },
);
