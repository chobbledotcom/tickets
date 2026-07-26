// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { adminBrowser, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  addAttendee,
  createListing,
  gotoListing,
  lineIndexOnPage,
  openAttendeeEditor,
} from "#test-utils/e2e.ts";
import {
  extractFormEntries,
  type TestBrowser,
} from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const ART_CLASS = "Art Class";
const MORNING = "Morning Workshop";
const EVENING = "Evening Seminar";

/** The new details an organiser types in, and the booking that must survive. */
interface Rename {
  address: string;
  email: string;
  newName: string;
  oldName: string;
  phone: string;
  places: string;
  special_instructions: string;
}

const ALICE: Rename = {
  address: "42 Oak Street",
  email: "alice.johnson@example.com",
  newName: "Alice Johnson",
  oldName: "Alice Smith",
  phone: "+449876543210",
  places: "2",
  special_instructions: "Needs wheelchair access",
};

const BOB: Rename = {
  address: "7 Pine Avenue",
  email: "robert@example.com",
  newName: "Robert Jones",
  oldName: "Bob Jones",
  phone: "+441111222333",
  places: "1",
  special_instructions: "Vegetarian meals",
};

const listingIdFor = (world: TicketsWorld, name: string): string =>
  String(requiredWorldValue(world.listingIds.get(name), `${name} listing id`));

/** Add the person to a fresh Art Class through the quick-add form. */
const addToArtClass = async (
  world: TicketsWorld,
  person: Rename,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  const id = await createListing(browser, { name: ART_CLASS });
  world.listingIds.set(ART_CLASS, Number(id));
  await addAttendee(browser, {
    name: person.oldName,
    quantity: person.places,
  });
  expect(browser.containsText(`Added ${person.oldName}`)).toBe(true);
  return browser;
};

/** Type the new name and contact details into the real attendee editor. */
const saveNewDetails = async (
  world: TicketsWorld,
  person: Rename,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await openAttendeeEditor(browser);
  await browser.submitForm(
    {
      address: person.address,
      email: person.email,
      name: person.newName,
      phone: person.phone,
      special_instructions: person.special_instructions,
    },
    "Save Attendee",
  );
  expect(browser.containsText(`Updated ${person.newName}`)).toBe(true);
  return browser;
};

/** The editor holds the new details, and only the new name is editable. The
 * old name lives on in the activity log, so the name is checked as a field
 * value rather than anywhere on the page. */
const expectSavedDetails = async (
  world: TicketsWorld,
  person: Rename,
): Promise<void> => {
  const html = scenarioBrowser(world).currentHtml;
  expect(html).toContain(`value="${person.newName}"`);
  expect(html).not.toContain(`value="${person.oldName}"`);
  for (const detail of [
    person.address,
    person.email,
    person.phone,
    person.special_instructions,
  ]) {
    expect(html).toContain(detail);
  }
};

/** The places the editor would send for one listing's line. Read from the
 * line's own box, so a place moved to another line — or dropped — is caught. */
const placesShownForListing = (
  browser: TestBrowser,
  listingId: string,
): string => {
  const field = `qty_${lineIndexOnPage(browser, listingId)}`;
  const entry = extractFormEntries(browser.currentHtml).find(
    ([name]) => name === field,
  );
  if (!entry) throw new Error(`the editor has no ${field} box`);
  return entry[1];
};

/** The booking kept its places, and the check-in is exactly as it was. */
const expectKeptBooking = (
  world: TicketsWorld,
  person: Rename,
  checkedIn: boolean,
): void => {
  const browser = scenarioBrowser(world);
  expect(placesShownForListing(browser, listingIdFor(world, ART_CLASS))).toBe(
    person.places,
  );
  expect(browser.currentHtml.includes("Checked in")).toBe(checkedIn);
};

/** Save one listing's places for the attendee whose editor is open. The editor
 * names its fields by line position, so the line is read from the page first. */
const savePlaces = async (
  browser: TestBrowser,
  name: string,
  listingId: string,
  places: string,
): Promise<void> => {
  await browser.submitForm(
    { name, [`qty_${lineIndexOnPage(browser, listingId)}`]: places },
    "Save Attendee",
  );
  expect(browser.containsText(`Updated ${name}`)).toBe(true);
};

Given(
  "Alice Smith is checked in for Art Class with two places",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await addToArtClass(this, ALICE);
    // The roster's only attendee is Alice, so the first Check in is hers.
    await browser.submitForm({}, "Check in");
    expect(browser.containsText(`Checked ${ALICE.oldName} in`)).toBe(true);
  },
);

Given(
  "Bob Jones has one Art Class place and is not checked in",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await addToArtClass(this, BOB);
    expect(browser.containsText("Check out")).toBe(false);
  },
);

When(
  "the organiser renames her to Alice Johnson and saves new contact details",
  async function (this: TicketsWorld): Promise<void> {
    await saveNewDetails(this, ALICE);
  },
);

When(
  "the organiser renames him to Robert Jones and saves new contact details",
  async function (this: TicketsWorld): Promise<void> {
    await saveNewDetails(this, BOB);
  },
);

Then(
  "Alice Johnson's record shows her new contact details",
  function (this: TicketsWorld): Promise<void> {
    return expectSavedDetails(this, ALICE);
  },
);

Then(
  "Robert Jones's record shows his new contact details",
  function (this: TicketsWorld): Promise<void> {
    return expectSavedDetails(this, BOB);
  },
);

Then(
  "Alice Johnson still has two Art Class places and is still checked in",
  function (this: TicketsWorld): void {
    expectKeptBooking(this, ALICE, true);
  },
);

Then(
  "Robert Jones still has one Art Class place and is not checked in",
  function (this: TicketsWorld): void {
    expectKeptBooking(this, BOB, false);
  },
);

Then(
  "the Art Class attendee list does not show Alice Smith",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await gotoListing(browser, ART_CLASS);
    expect(browser.containsText(ALICE.newName)).toBe(true);
    expect(browser.containsText(ALICE.oldName)).toBe(false);
  },
);

Given(
  "Alice Smith and Bob Jones each have a Morning Workshop place",
  async function (this: TicketsWorld): Promise<void> {
    for (const name of [MORNING, EVENING]) {
      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name,
      });
      this.listingIds.set(name, listing.id);
    }
    this.attendeeIds = [];
    for (const person of [ALICE, BOB]) {
      const { attendee } = await createTestAttendeeDirect(
        Number(listingIdFor(this, MORNING)),
        person.oldName,
        person.email,
      );
      this.attendeeIds.push(attendee.id);
    }
  },
);

When(
  "the organiser moves both of them to Evening Seminar",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    const ids = requiredWorldValue(this.attendeeIds, "attendee ids");
    const morning = listingIdFor(this, MORNING);
    const evening = listingIdFor(this, EVENING);
    for (const [index, attendeeId] of ids.entries()) {
      const name = [ALICE, BOB][index]!.oldName;
      // Give the new listing a place, then take the old listing's place away.
      await browser.visit(`/admin/attendees/${attendeeId}/edit`);
      expect(browser.containsText(MORNING)).toBe(true);
      expect(browser.containsText(EVENING)).toBe(true);
      await savePlaces(browser, name, evening, "1");
      await savePlaces(browser, name, morning, "0");
    }
  },
);

Then(
  "Morning Workshop has no attendees",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await gotoListing(browser, MORNING);
    expect(browser.containsText(ALICE.oldName)).toBe(false);
    expect(browser.containsText(BOB.oldName)).toBe(false);
  },
);

Then(
  "Evening Seminar shows Alice Smith and Bob Jones",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await gotoListing(browser, EVENING);
    expect(browser.containsText(ALICE.oldName)).toBe(true);
    expect(browser.containsText(BOB.oldName)).toBe(true);
  },
);
