// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { adminBrowser, scenarioBrowser } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { ALL_CHECKBOXES, type TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const LISTING = "Summer Concert";
const GROUP = "Summer Festival";
const QUESTION = "What is your t-shirt size?";
const SIZES = ["Small", "Medium", "Large"];
const CHOSEN_SIZE = "Medium";
const CUSTOMER = "Jane Doe";
const CUSTOMER_EMAIL = "jane@example.com";

const listingId = (world: TicketsWorld): number =>
  requiredWorldValue(world.listingIds.get(LISTING), `${LISTING} listing id`);

/** Build the listing the way an organiser does: pick the type from the
 * template chooser, then fill in the advanced form. */
const createListingThroughChooser = async (
  browser: TestBrowser,
): Promise<number> => {
  await browser.visit("/admin/");
  await browser.clickLink("Add Listing");
  expect(browser.containsText("Choose a listing type")).toBe(true);
  await browser.clickLink("Custom / advanced");
  await browser.submitForm(
    {
      description: "A wonderful summer evening of music",
      fields: ["email"],
      max_attendees: "100",
      max_quantity: "5",
      name: LISTING,
    },
    "Create Listing",
  );
  expect(browser.containsText(LISTING)).toBe(true);
  await browser.clickLink(LISTING);
  const id = browser.currentUrl.match(/\/admin\/listing\/(\d+)/)?.[1];
  return Number(requiredWorldValue(id, `${LISTING} listing id`));
};

/** Ask one question with its three answers, then tick it on the listing. */
const askSizeQuestion = async (
  browser: TestBrowser,
  id: number,
): Promise<void> => {
  await browser.visit("/admin/questions");
  expect(browser.containsText("Custom Questions")).toBe(true);
  // Adding a question opens its own page, where its answers are added.
  await browser.submitForm({ text: QUESTION }, "Add Question");
  expect(browser.containsText(QUESTION)).toBe(true);
  for (const size of SIZES) {
    await browser.submitForm({ text: size }, "Add Answer");
  }
  for (const size of SIZES) {
    expect(browser.containsText(size)).toBe(true);
  }
  await browser.visit(`/admin/listing/${id}/questions`);
  expect(browser.currentHtml).toContain('name="question_ids"');
  await browser.submitForm({ question_ids: ALL_CHECKBOXES }, "Save");
  expect(browser.containsText("Questions updated")).toBe(true);
};

/** Put the listing in a new group and return the group's public booking path. */
const groupTheListing = async (browser: TestBrowser): Promise<string> => {
  await browser.visit("/admin/groups/new");
  expect(browser.containsText("Add Group")).toBe(true);
  await browser.submitForm({ name: GROUP }, "Create Group");
  expect(browser.containsText(GROUP)).toBe(true);
  expect(browser.currentHtml).toContain('name="listing_ids"');
  await browser.submitForm(
    { listing_ids: ALL_CHECKBOXES },
    "Add Selected Listings",
  );
  expect(browser.containsText(LISTING)).toBe(true);
  // The group page shows its own public booking link.
  const link = browser.links.find((entry) =>
    entry.text.includes("localhost/ticket/"),
  );
  const href = requiredWorldValue(link?.href, "group public booking link");
  return href.startsWith("http") ? new URL(href).pathname : href;
};

Given(
  "the organiser has a Summer Concert listing in the Summer Festival group that asks for a t-shirt size",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    const id = await createListingThroughChooser(browser);
    this.listingIds.set(LISTING, id);
    await askSizeQuestion(browser, id);
    this.bookingPath = await groupTheListing(browser);
  },
);

When(
  "a customer books one Summer Concert place and picks the Medium size",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.visit(requiredWorldValue(this.bookingPath, "booking path"));
    // A group page asks for a quantity per listing and renders the question's
    // answers as radios, so both field names are read from the served form.
    const quantityField = browser.currentHtml.match(/name="quantity_(\d+)"/);
    const size = browser.currentHtml.match(
      new RegExp(
        `name="(question_\\d+)"[^>]*value="(\\d+)"[^>]*>\\s*${CHOSEN_SIZE}`,
      ),
    );
    expect(quantityField).not.toBeNull();
    expect(size).not.toBeNull();
    await browser.submitForm(
      {
        email: CUSTOMER_EMAIL,
        name: CUSTOMER,
        [`quantity_${quantityField![1]!}`]: "1",
        [size![1]!]: size![2]!,
      },
      "Continue",
    );
    expect(browser.containsText("Thank you for your order")).toBe(true);
  },
);

Then(
  "the customer can open a ticket for Summer Concert",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.clickLink("View your ticket");
    expect(browser.currentUrl).toMatch(/^\/t\//);
    expect(browser.containsText(LISTING)).toBe(true);
  },
);

Then(
  "the Summer Concert attendee list shows the customer and their email",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.visit(`/admin/listing/${listingId(this)}/attendees`);
    expect(browser.containsText(CUSTOMER)).toBe(true);
    expect(browser.containsText(CUSTOMER_EMAIL)).toBe(true);
  },
);

Then(
  "the Summer Concert list download shows the customer picked Medium",
  async function (this: TicketsWorld): Promise<void> {
    const browser = scenarioBrowser(this);
    await browser.visit(`/admin/listing/${listingId(this)}/attendees`);
    await browser.clickLink("Export CSV");
    const [headerLine, dataLine] = browser.currentHtml.split("\n");
    const columns = requiredWorldValue(headerLine, "download header").split(
      ",",
    );
    const answerColumn = columns.findIndex((column) =>
      column.includes(QUESTION),
    );
    expect(answerColumn).toBeGreaterThan(-1);
    const values = requiredWorldValue(dataLine, "download row").split(",");
    expect(values[answerColumn]).toBe(CHOSEN_SIZE);
  },
);
