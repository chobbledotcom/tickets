/**
 * The owner's own Privacy page: the records a deleted listing leaves behind,
 * and forgetting one person on request.
 *
 * Everything here goes through the page's own two forms and the listing's own
 * delete link, so a control the site stopped offering fails the story rather
 * than being reached around. The one person these stories are about is known to
 * the site in two ways — the email and the phone they booked with — and each way
 * is a note of its own, which is what the forgetting rule is about.
 */

import { expect } from "@std/expect";
import {
  type ContactChannel,
  contactHash,
  getVisits,
} from "#db/contact-preferences.ts";
import { t } from "#i18n";
import { somebodyBooksThroughTheSite } from "#test/specs/support/booking-setup.ts";
// jscpd:ignore-start
import {
  openAdminPage,
  opensAdminPageAt,
  organiserSendsAndIsTold,
  wordsOnPageFrom,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  choicesOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls/reading.ts";
import { takeDownFromActions } from "#test/specs/support/form-controls.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type {
  ActOnOneThing,
  AsksAboutOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** The listing every scenario here buys a place on. */
export const POTTERY = "Pottery Class";

/** The person the stories are about, and the two ways they give the site to
 * reach them. */
const ADA = {
  email: "ada@example.com",
  name: "Ada",
  phone: "07700 900222",
} as const;

/** A way the site knows somebody, in the words the stories use. */
export type WayOfKnowingSomebody = "email" | "phone";

/** The same way of knowing them, in the words the site's own form uses. */
const CHANNEL_OF: Record<WayOfKnowingSomebody, ContactChannel> = {
  email: "email",
  phone: "sms",
};

/** What Ada typed in that box when they booked. */
const WHAT_ADA_TYPED: Record<WayOfKnowingSomebody, string> = {
  email: ADA.email,
  phone: ADA.phone,
};

/** The organiser's own Privacy page, open in their window. */
const openPrivacyPage = opensAdminPageAt("/admin/privacy");

/** What the Privacy page says right now, read fresh — every rule here is about
 * what the organiser sees the next time they look. */
export const whatThePrivacyPageSays = wordsOnPageFrom(openPrivacyPage);

/** How many times the site has seen somebody, found the way the site finds
 * them: by a one-way code made from the email or phone, never by the address
 * itself. */
export const timesTheSiteHasSeen = async (
  way: WayOfKnowingSomebody,
): Promise<number> =>
  getVisits(await contactHash(CHANNEL_OF[way], WHAT_ADA_TYPED[way]));

/** Ada books a place the ordinary way, on a listing that asks for whichever
 * details the story needs them to give. The site's own thank-you page is kept so
 * the booking finishes here rather than off at another site.
 *
 * The site has to have noticed them, or "nothing is counted about them" later
 * would be true before the organiser did anything at all. */
export const adaBooks = async (
  world: TicketsWorld,
  alsoGivingAPhone: boolean,
): Promise<void> => {
  await somebodyBooksThroughTheSite(world, {
    email: ADA.email,
    listingName: POTTERY,
    who: ADA.name,
    ...(alsoGivingAPhone ? { phone: ADA.phone } : {}),
  });
  const ways: WayOfKnowingSomebody[] = alsoGivingAPhone
    ? ["email", "phone"]
    : ["email"];
  for (const way of ways) {
    expect(await timesTheSiteHasSeen(way)).toBe(1);
  }
};

/** One listing's own page, or one of the pages behind it, open in front of the
 * organiser. Everything they do to a listing starts here. */
const listingPage = (
  world: TicketsWorld,
  name: string,
  behind = "",
): Promise<TestBrowser> =>
  openAdminPage(
    world,
    `/admin/listing/${listingIdNamed(world, name)}${behind}`,
  );

/** The organiser deletes a listing, following the way in they really have: its
 * own page, the Actions tab behind it, then typing the name to confirm. */
export const organiserDeletesListing: ActOnOneThing = async (world, name) => {
  const browser = await listingPage(world, name);
  const told = await takeDownFromActions(browser, name, {
    deleteLink: t("common.delete"),
    submit: t("listings_table.delete_listing"),
  });
  // A delete the site refused would leave every later reading unchanged, and
  // "nothing was left behind" would look like a pass.
  expect(told).toContain(t("success.listing_deleted"));
};

/** Whether the listing still lists Ada. Read from the organiser's own attendee
 * list, because "their booking is untouched" is a thing they can see. */
export const listingStillLists: AsksAboutOneThing = async (world, name) =>
  (await listingPage(world, name, "/attendees")).containsText(ADA.name);

/** The box on the orphaned-records form that says the site should do the
 * clearing out by itself, and the dropdown beside it for how old a record has
 * to be. */
const BY_ITSELF = "auto_purge";
const AGE_CHOOSER = "retention";

/** The value the page's own dropdown sends for an age the organiser reads on
 * screen. Both halves are read off the served page, so a form that put the
 * wrong words beside an age fails the story: the organiser could not have
 * chosen the age the story names. */
const ageOffered = (html: string, label: string): string => {
  const choice = choicesOffered(html, AGE_CHOOSER).find(
    (offered) => offered.label === label,
  );
  if (!choice) throw new Error(`The page offers no age called "${label}"`);
  return choice.value;
};

/** What the page's forms would send if the organiser pressed a button without
 * changing anything — the values the site has filled in for them. */
const alreadyFilledIn = (html: string, field: string): string[] =>
  extractFormEntries(html)
    .filter(([name]) => name === field)
    .map(([, value]) => value);

/** Something the organiser does on the orphaned-records form, told the age to
 * choose on the way. Both of that form's buttons work this way. */
type FillsInTheOrphansForm = (
  world: TicketsWorld,
  age: string,
) => Promise<void>;

/** Pressing one of the orphaned-records form's two buttons. Saving and clearing
 * out differ only in which button that is and whether the organiser leaves the
 * site to do it by itself, so each one is this with its own choice made. The
 * button is named by its key rather than its words, because the page's copy is
 * only loaded once the page itself has been served. */
const pressesOnOrphansForm =
  (choice: { byItself: boolean; pressingKey: string }): FillsInTheOrphansForm =>
  async (world, age) => {
    const browser = await openPrivacyPage(world);
    const tick = checkboxValueOffered(browser.currentHtml, BY_ITSELF);
    // The box starts ticked, so a story that clears it is really changing
    // something. A page that came back already clear would make that a no-op.
    expect(tickedCheckboxes(browser.currentHtml, BY_ITSELF)).toContain(tick);
    await organiserSendsAndIsTold(
      world,
      browser,
      { [AGE_CHOOSER]: ageOffered(browser.currentHtml, age) },
      t(choice.pressingKey),
      { [BY_ITSELF]: choice.byItself ? [tick] : [] },
    );
  };

/** The organiser clears out the records left behind, choosing how old one has
 * to be. They leave the site clearing out by itself, as it does by default. */
export const organiserClearsOutRecords = pressesOnOrphansForm({
  byItself: true,
  pressingKey: "privacy.orphans.purge_button",
});

/** The organiser saves their choices and stops the site clearing records out by
 * itself, without asking for anything to go now. */
export const organiserSavesChoices = pressesOnOrphansForm({
  byItself: false,
  pressingKey: "privacy.orphans.save_button",
});

/** What the orphaned-records form is offering the organiser now, in their own
 * words: the age it is set to, and whether it will clear out by itself. */
export const whatTheFormOffers = async (
  world: TicketsWorld,
): Promise<{ age: string; byItself: boolean }> => {
  const html = (await openPrivacyPage(world)).currentHtml;
  const set = alreadyFilledIn(html, AGE_CHOOSER);
  const age = choicesOffered(html, AGE_CHOOSER).find(({ value }) =>
    set.includes(value),
  );
  if (!age) throw new Error("The form is set to no age at all");
  return {
    age: age.label,
    byItself: tickedCheckboxes(html, BY_ITSELF).length > 0,
  };
};

/** The organiser deletes one person's record, finding them the way the form
 * offers: by email or by phone, and typing what they booked with. */
const sendsEraseForm = async (
  world: TicketsWorld,
  found: { by: WayOfKnowingSomebody; typing: string },
): Promise<void> => {
  const browser = await openPrivacyPage(world);
  await organiserSendsAndIsTold(
    world,
    browser,
    { contact_type: CHANNEL_OF[found.by], identifier: found.typing },
    t("privacy.erase.button"),
  );
};

/** The organiser forgets Ada, found by one of the two ways they are known. */
export const organiserForgetsAda = (
  world: TicketsWorld,
  way: WayOfKnowingSomebody,
): Promise<void> =>
  sendsEraseForm(world, { by: way, typing: WHAT_ADA_TYPED[way] });

/** The organiser sends the erase form with one email address typed in. */
const forgettingTheEmail =
  (typing: string) =>
  (world: TicketsWorld): Promise<void> =>
    sendsEraseForm(world, { by: "email", typing });

/** The organiser looks for an email address nobody ever booked with. */
export const organiserForgetsAStranger =
  forgettingTheEmail("nobody@example.com");

/** The organiser presses delete having typed nothing at all. The box is not a
 * required one, so this is a send a real browser would let them make. */
export const organiserForgetsNobodyInParticular = forgettingTheEmail("");
