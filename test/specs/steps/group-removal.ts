/** The group's own page removing one listing from the group: the typed-name
 * confirmation, what the page says will happen, what the operator is told
 * afterwards, and which surfaces still offer the listing afterwards. */

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { t } from "#i18n";
import {
  adminBrowser,
  adminPageHtmlAt,
  browserSeenBy,
  keepsWhatTheOrganiserSaw,
  ORGANISER,
  rememberBrowser,
  visiting,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { findOrCreateGroup, groupNamed } from "#test/specs/support/groups.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { attrValue, findForms } from "#test-utils/test-browser/forms.ts";
import { regexCollect } from "#test-utils/test-browser/parsing.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

Given(
  "the site also has {string} in the {string} group",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
  ): Promise<void> {
    const group = await findOrCreateGroup(groupName);
    await assignListingsToGroup([listingNamed(this, listingName).id], group.id);
  },
);

/** The group's own record page, found by the name the story calls it. */
const groupPagePath = async (groupName: string): Promise<string> =>
  `/admin/groups/${(await groupNamed(groupName)).id}`;

/** The remove form's body, or a loud failure when the page offers none. */
const removeFormOn = (html: string, path: string): string => {
  const form = findForms(html).find(
    (entry) => entry.action === `${path}/remove-listings`,
  );
  if (!form) {
    throw new Error(`No remove form on ${path}`);
  }
  return form.body;
};

/** The value the form's own box for one named listing carries, read from the
 * served page so a listing the page stopped offering cannot be picked. */
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

/** Send the group page's remove form the way a browser does: its ticked boxes
 * travel to the confirmation page as the query string. The window they open
 * is kept, so a later step can read the confirmation page itself. */
const openRemovalPage = async (
  world: TicketsWorld,
  listingName: string,
  groupName: string,
): Promise<TestBrowser> => {
  const path = await groupPagePath(groupName);
  const html = await adminPageHtmlAt(world, path);
  const value = removeBoxValue(removeFormOn(html, path), listingName);
  const browser = await visiting(
    await adminBrowser(world),
    `${path}/remove-listings?listing_ids=${value}`,
  );
  return rememberBrowser(world, ORGANISER, browser);
};

/** Type `typed` as the confirm name and send the confirmation form. */
const sendRemovalForm = async (
  world: TicketsWorld,
  browser: TestBrowser,
  typed: string,
): Promise<void> => {
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    t("groups.remove.submit"),
  );
  keepsWhatTheOrganiserSaw(world, browser);
};

When(
  "the organiser removes {string} from the {string} group's page",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
  ): Promise<void> {
    await sendRemovalForm(
      this,
      await openRemovalPage(this, listingName, groupName),
      groupName,
    );
  },
);

When(
  "the organiser tries to remove {string} from the {string} group's page, typing {string} instead",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
    typed: string,
  ): Promise<void> {
    await sendRemovalForm(
      this,
      await openRemovalPage(this, listingName, groupName),
      typed,
    );
  },
);

When(
  "the organiser chooses {string} for removal from the {string} group's page",
  async function (
    this: TicketsWorld,
    listingName: string,
    groupName: string,
  ): Promise<void> {
    await openRemovalPage(this, listingName, groupName);
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

Then(
  "the removal page names {string}",
  function (this: TicketsWorld, listingName: string): void {
    expect(browserSeenBy(this, ORGANISER).pageText).toContain(listingName);
  },
);

Then(
  "the removal page says each listing keeps its bookings and its money",
  function (this: TicketsWorld): void {
    expect(browserSeenBy(this, ORGANISER).pageText).toContain(
      "Each listing keeps its bookings and its money.",
    );
  },
);

/** Whether one of the group page's own checkbox lists still offers a listing
 * by name. Reading the served form is what tells one list from the other. */
const pageOffersListing = (html: string, action: string, listingName: string) =>
  findForms(html)
    .find((entry) => entry.action === action)
    ?.body.includes(listingName) ?? false;

const offeringsOf = async (
  world: TicketsWorld,
  groupName: string,
): Promise<{ path: string; html: string }> => {
  const path = await groupPagePath(groupName);
  return { html: await adminPageHtmlAt(world, path), path };
};

/** The shared tail of the "still/no longer offers for removal" pair, curried
 * on the answer the page gives. */
const removalOfferedToBe = (expected: boolean) =>
  async function (
    this: TicketsWorld,
    groupName: string,
    listingName: string,
  ): Promise<void> {
    const { path, html } = await offeringsOf(this, groupName);
    expect(
      pageOffersListing(html, `${path}/remove-listings`, listingName),
    ).toBe(expected);
  };

Then(
  "the {string} group's page no longer offers {string} for removal",
  removalOfferedToBe(false),
);

Then(
  "the {string} group's page still offers {string} for removal",
  removalOfferedToBe(true),
);

Then(
  "the {string} group's page offers {string} for adding again",
  async function (
    this: TicketsWorld,
    groupName: string,
    listingName: string,
  ): Promise<void> {
    const { path, html } = await offeringsOf(this, groupName);
    expect(pageOffersListing(html, `${path}/add-listings`, listingName)).toBe(
      true,
    );
  },
);
