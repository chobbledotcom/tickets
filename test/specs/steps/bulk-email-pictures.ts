/** The picture a message names: where the preview shows it, where each sent
 * copy carries it, and what the owner wrote as code or as a web address
 * beside it. */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { getEffectiveDomain } from "#shared/config.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  bookedOnto,
  type MessageWritten,
  mailtoDraftBody,
  pictureTag,
  pictureUrl,
  seedAPicture,
  whatWasSentTo,
  writesToListing,
  writtenMessage,
} from "#test/specs/support/bulk-email.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The message the owner writes when they name a picture: their words, then
 * the reference the editor's dropdown leaves in the box. The words may name
 * the picture's number as {the picture's number}, the way a web address
 * that carries it does. */
const messageAboutPicture = (
  world: TicketsWorld,
  name: string,
  words: string,
): MessageWritten => {
  const picture = world.things.require("picture", name);
  const written = words.replaceAll(
    "{the picture's number}",
    String(picture.id),
  );
  return writtenMessage(`${written} ![${name}](img#${picture.id})`, false);
};

Given(
  "the site holds a picture called {string}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await seedAPicture(this, name);
  },
);

When(
  "the owner writes to {string} about the picture {string} saying {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    name: string,
    words: string,
  ): Promise<void> {
    return writesToListing(
      this,
      listingName,
      messageAboutPicture(this, name, words),
    );
  },
);

Then(
  "the owner is shown the message before it goes, with the {string} picture in place of its reference",
  function (this: TicketsWorld, name: string): void {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain(t("bulk_email.message_preview_heading"));
    // The reference the owner typed never reaches the preview as text: it
    // renders as the picture.
    expect(browser.pageText).not.toContain("img#");
    expect(browser.currentHtml).toContain(
      pictureTag(pictureUrl(this, name), name),
    );
  },
);

Then(
  "the draft they can send themselves names the {string} picture at its address on the site",
  function (this: TicketsWorld, name: string): void {
    const draft = mailtoDraftBody(this);
    expect(draft).toContain(
      pictureUrl(this, name, `https://${getEffectiveDomain()}`),
    );
    // A written reference would reach the owner's email app unresolved.
    expect(draft).not.toContain("img#");
  },
);

Then(
  "the copy for everyone who booked onto {string} shows the {string} picture at its address on the site",
  function (this: TicketsWorld, listingName: string, name: string): void {
    const origin = `https://${getEffectiveDomain()}`;
    const fromTheSite = pictureTag(pictureUrl(this, name, origin), name);
    const atTheSite = pictureUrl(this, name, origin);
    for (const email of bookedOnto(this, listingName)) {
      const copy = whatWasSentTo(this, email);
      expect(copy.html).toContain(fromTheSite);
      // An email reader cannot follow an address that starts with a slash,
      // so neither a half address nor an unresolved reference may reach one.
      expect(copy.html).not.toContain('src="/image/');
      expect(copy.html).not.toContain("img#");
      // The plain part a text-only reader shows names the same address.
      expect(copy.text).toContain(atTheSite);
      expect(copy.text).not.toContain("img#");
    }
  },
);

/** A web address that merely names the picture arrives as the owner wrote
 * it, with the picture's number still in it. */
const expectWebAddressKept = (
  body: string,
  address: string,
  pictureNumber: number,
): void => {
  expect(body).toContain(`${address}${pictureNumber}`);
  // The picture's own address must never end up inside the page's address.
  expect(body).not.toContain(`${address}https://`);
};

Then(
  "the draft they can send themselves still links to {string} with the {string} picture's number",
  function (this: TicketsWorld, address: string, name: string): void {
    const draft = mailtoDraftBody(this);
    expectWebAddressKept(
      draft,
      address,
      this.things.require("picture", name).id,
    );
    // The picture in the same message still travels to its address on the
    // site.
    expect(draft).toContain(
      pictureUrl(this, name, `https://${getEffectiveDomain()}`),
    );
  },
);

Then(
  "the copy for everyone who booked onto {string} still links to {string} with the {string} picture's number",
  function (
    this: TicketsWorld,
    listingName: string,
    address: string,
    name: string,
  ): void {
    const origin = `https://${getEffectiveDomain()}`;
    const pictureNumber = this.things.require("picture", name).id;
    for (const email of bookedOnto(this, listingName)) {
      const copy = whatWasSentTo(this, email);
      expectWebAddressKept(copy.text, address, pictureNumber);
      // The read page was never rewritten, so its link keeps the address too.
      expect(copy.html).toContain(`href="${address}${pictureNumber}"`);
      // The picture in the same message still carries its own address.
      expect(copy.text).toContain(pictureUrl(this, name, origin));
    }
  },
);

/** The words the owner wrote, with the picture's number filled in where the
 * step named it as {the picture's number}. */
const writtenWords = (
  world: TicketsWorld,
  name: string,
  words: string,
): string =>
  words.replaceAll(
    "{the picture's number}",
    String(world.things.require("picture", name).id),
  );

Then(
  "the draft they can send themselves still shows {string} as the owner wrote it, and the {string} picture at its address on the site",
  function (this: TicketsWorld, words: string, name: string): void {
    const draft = mailtoDraftBody(this);
    expect(draft).toContain(writtenWords(this, name, words));
    expect(draft).toContain(
      pictureUrl(this, name, `https://${getEffectiveDomain()}`),
    );
  },
);

Then(
  "the copy for everyone who booked onto {string} still shows {string} as the owner wrote it, and the {string} picture at its address on the site",
  function (
    this: TicketsWorld,
    listingName: string,
    words: string,
    name: string,
  ): void {
    const origin = `https://${getEffectiveDomain()}`;
    const written = writtenWords(this, name, words);
    // The HTML part shows the code span without its backticks.
    const insideTheCode = written.slice(1, -1);
    for (const email of bookedOnto(this, listingName)) {
      const copy = whatWasSentTo(this, email);
      // The code the owner wrote arrives as code in the plain part, and the
      // picture beside it travels to the site's own address.
      expect(copy.text).toContain(written);
      expect(copy.text).toContain(pictureUrl(this, name, origin));
      // The HTML part shows the code as code too. The reference inside it
      // keeps the owner's words, so no picture appears inside the code
      // there.
      expect(copy.html).toContain(`<code>${insideTheCode}</code>`);
      expect(copy.html).toContain(
        pictureTag(pictureUrl(this, name, origin), name),
      );
    }
  },
);
