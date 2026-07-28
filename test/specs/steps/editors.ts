// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { formatCurrency, toMinorUnits } from "#shared/currency.ts";
import {
  editorAddsListing,
  editorBrowser,
  editorCraftsForwardingTo,
  editorFollowsInvite,
  editorLogsIn,
  editorOpensListing,
  forwardingAddress,
  listingSoldAsOrNull,
  OWNERS_ADDRESS,
  ownerInvitesEditor,
  ownerSetsForwardingTo,
  ownersListingsPage,
  pagesOfferedTo,
  privatePagePath,
  SOMEWHERE_ELSE,
  signedInEditor,
  somethingForSale,
  somethingSoldAndPaidFor,
  TAKINGS,
} from "#test/specs/support/editors.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the owner invites {word} to help with the listings",
  function (this: TicketsWorld, who: string): Promise<void> {
    return ownerInvitesEditor(this, who);
  },
);

When(
  "{word} follows the invite and chooses a password",
  function (this: TicketsWorld, _who: string): Promise<void> {
    return editorFollowsInvite(this);
  },
);

When(
  "{word} logs in",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await editorLogsIn(this, who);
  },
);

Given(
  "{word} is signed in as an editor",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await signedInEditor(this, who);
  },
);

Given(
  "somebody has bought and paid for a {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return somethingSoldAndPaidFor(this, name);
  },
);

Given(
  "the site sells a {word}, forwarding its bookings to the owner's address",
  function (this: TicketsWorld, name: string): Promise<void> {
    return somethingForSale(this, name, { forwardingTo: OWNERS_ADDRESS });
  },
);

When(
  "{word} adds a listing called {word}",
  function (this: TicketsWorld, _who: string, name: string): Promise<void> {
    return editorAddsListing(this, name);
  },
);

Then(
  "{word} is one of the things the site sells",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await listingSoldAsOrNull(name)).not.toBeNull();
  },
);

Then(
  "{word} is left on {word}, with the site saying it saved",
  async function (
    this: TicketsWorld,
    _who: string,
    name: string,
  ): Promise<void> {
    const made = await listingSoldAsOrNull(name);
    if (!made) throw new Error(`The site sells no ${name}`);
    // Back on the thing they just made, so the next edit needs no hunting and
    // the site has somewhere to say it worked.
    expect(editorBrowser(this).currentUrl).toBe(
      `/admin/listing/${made.id}/edit`,
    );
    expect(editorBrowser(this).pageText).toContain(
      t("success.listing_created"),
    );
  },
);

Then(
  "{word} is looking at the listings",
  function (this: TicketsWorld, _who: string): void {
    expect(editorBrowser(this).currentUrl).toBe("/admin/listings");
  },
);

When(
  "{word} opens the listings",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    await editorBrowser(this).visit("/admin/listings");
  },
);

When(
  "{word} asks for the {string} page",
  async function (
    this: TicketsWorld,
    _who: string,
    page: string,
  ): Promise<void> {
    this.editorRefusal = await editorBrowser(this).statusOf(
      privatePagePath(page),
    );
  },
);

Then(
  "{word} is told it is not theirs to open",
  function (this: TicketsWorld, _who: string): void {
    // Refused outright, not merely sent somewhere friendlier: a redirect would
    // leave the page reachable by anyone who followed it back.
    expect(
      requiredWorldValue(this.editorRefusal, "what the site answered"),
    ).toBe(403);
  },
);

Then(
  "{word} is offered the listings and the groups",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    const offered = (await pagesOfferedTo(editorBrowser(this))).map(
      ({ href }) => href,
    );
    expect(offered).toContain("/admin/listings");
    expect(offered).toContain("/admin/groups");
  },
);

Then(
  "every page {word} is offered is one they can open",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    // Asking the site about each link is stronger than naming the pages an
    // editor must not see: a page nobody thought of is covered too, and a link
    // that shuts in their face fails wherever it came from.
    const asked = await pagesOfferedTo(editorBrowser(this));
    expect(asked.length).toBeGreaterThan(0);
    const shutInTheirFace = asked.filter(({ answered }) => answered !== 200);
    expect(shutInTheirFace).toEqual([]);
  },
);

Then(
  "{word} is shown no takings for {word}",
  async function (
    this: TicketsWorld,
    _who: string,
    name: string,
  ): Promise<void> {
    const takings = formatCurrency(toMinorUnits(TAKINGS));
    // The owner's own copy of this page carries the figure, so the editor's
    // copy not carrying it means something. Without this, the check would pass
    // just as happily against a sale that never happened.
    expect(await ownersListingsPage(this)).toContain(takings);

    const shown = editorBrowser(this).pageText;
    expect(shown).toContain(name);
    // Not the column headings, and not the figure itself — a takings column
    // renamed or left unlabelled would still be money on their screen.
    for (const money of ["Revenue", "Profit", takings]) {
      expect(shown).not.toContain(money);
    }
  },
);

When(
  "{word} opens {word} to edit it",
  async function (
    this: TicketsWorld,
    _who: string,
    name: string,
  ): Promise<void> {
    await editorOpensListing(this, name);
  },
);

Then(
  "{word} is not asked where bookings are forwarded",
  function (this: TicketsWorld, _who: string): void {
    // No box for it, and no sight of it either — showing the address as plain
    // text would tell them just as much as a box would.
    const served = editorBrowser(this).currentHtml;
    expect(served).not.toContain('name="webhook_url"');
    expect(served).not.toContain(OWNERS_ADDRESS);
  },
);

When(
  "{word} saves {word} with somewhere else to forward bookings to",
  function (this: TicketsWorld, _who: string, name: string): Promise<void> {
    return editorCraftsForwardingTo(this, name, SOMEWHERE_ELSE);
  },
);

When(
  "the owner saves {word} with somewhere else to forward bookings to",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // The owner making the same change through their own box is what proves the
    // editor was stopped by the rule, and not by some unrelated refusal.
    await ownerSetsForwardingTo(this, name, SOMEWHERE_ELSE);
  },
);

Then(
  "{word} still forwards its bookings to the owner's address",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await forwardingAddress(this, name)).toBe(OWNERS_ADDRESS);
  },
);

Then(
  "{word} forwards its bookings somewhere else",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await forwardingAddress(this, name)).toBe(SOMEWHERE_ELSE);
  },
);
