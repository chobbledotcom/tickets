/**
 * Questions an owner puts on booking, and what buyers say back. The buyer's
 * half always drives the real public page, because the question is only worth
 * asking if it renders where a buyer would answer it.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import {
  adminBrowser,
  openAdminPage,
  openAsNewcomer,
  takesDownFromOwnPage,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { stayListing, tickOnListingTab } from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The question this story asked, or a loud failure when it never asked one. */
export const askedQuestion = (
  world: TicketsWorld,
): { id: number; text: string } =>
  requiredWorldValue(world.buyerQuestion, "the question the owner asked");

/** The owner writes a question, of either kind, and lands on its own page.
 * The id is read from where the site sent them, so everything later acts on
 * the question the site really made. */
const ownerWritesQuestion = async (
  world: TicketsWorld,
  text: string,
  displayType: "radio" | "free_text",
): Promise<TestBrowser> => {
  const browser = await openAdminPage(world, "/admin/questions");
  await fillInAndSend(
    browser,
    { display_type: displayType, text },
    "Add Question",
  );
  const id = browser.currentUrl.match(/\/admin\/questions\/(\d+)/)?.[1];
  world.buyerQuestion = {
    id: Number(requiredWorldValue(id, `the page for the question "${text}"`)),
    text,
  };
  return browser;
};

/** Tick the question on one listing's own questions tab. */
const ownerAssignsQuestionTo = (
  world: TicketsWorld,
  listingName: string,
): Promise<void> =>
  tickOnListingTab(
    world,
    listingName,
    "questions",
    "question_ids",
    askedQuestion(world).id,
    "Questions updated",
  );

/** A choice question with its answers, asked of one listing's buyers. */
export const ownerAsksChoiceQuestion = async (
  world: TicketsWorld,
  listingName: string,
  text: string,
  answers: string[],
): Promise<void> => {
  const browser = await ownerWritesQuestion(world, text, "radio");
  for (const answer of answers) {
    await fillInAndSend(browser, { text: answer }, "Add Answer");
  }
  for (const answer of answers) {
    expect(browser.pageText).toContain(answer);
  }
  await ownerAssignsQuestionTo(world, listingName);
};

/** A written question — no answers to offer — asked of one listing's buyers,
 * or of nobody yet when no listing is named. */
export const ownerAsksWrittenQuestion = async (
  world: TicketsWorld,
  text: string,
  listingName?: string,
): Promise<void> => {
  await ownerWritesQuestion(world, text, "free_text");
  if (listingName) await ownerAssignsQuestionTo(world, listingName);
};

/** The booking page a visitor sees for this listing, opened by somebody who
 * was never signed in. */
export const visitorOpensBooking = async (
  world: TicketsWorld,
  listingName: string,
): Promise<TestBrowser> =>
  openAsNewcomer(`/ticket/${stayListing(world, listingName).slug}`);

/** The field the served page offers for this question, or a loud failure —
 * asserting on a page that stopped asking would prove nothing. */
export const questionFieldOn = (
  world: TicketsWorld,
  browser: TestBrowser,
): string => {
  const name = `question_${askedQuestion(world).id}`;
  expect(browser.currentHtml).toContain(`name="${name}"`);
  return name;
};

/** A visitor books one place, answering the written question in their own
 * words — typed into the box the served page really offers. */
export const visitorBooksAnswering = async (
  world: TicketsWorld,
  listingName: string,
  answer: string,
): Promise<void> => {
  const browser = await visitorOpensBooking(world, listingName);
  await browser.submitForm(
    {
      email: "buyer@example.com",
      name: "Casey Buyer",
      [`quantity_${stayListing(world, listingName).id}`]: "1",
      [questionFieldOn(world, browser)]: answer,
    },
    "Continue",
  );
  expect(browser.pageText).toContain("Thank you for your order");
};

/** What the owner's list download says this booking answered. The download is
 * where every answer ends up, whichever kind of question it came from. */
export const answerInListDownload = async (
  world: TicketsWorld,
  listingName: string,
): Promise<string> => {
  const listing = stayListing(world, listingName);
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${listing.id}/attendees`);
  await browser.clickLink("Export CSV");
  const [headerLine, dataLine] = browser.currentHtml.split("\n");
  const columns = requiredWorldValue(headerLine, "list download header").split(
    ",",
  );
  const question = askedQuestion(world);
  const answerColumn = columns.findIndex((column) =>
    column.includes(question.text),
  );
  if (answerColumn === -1) {
    throw new Error(`The list download has no column for "${question.text}"`);
  }
  const values = requiredWorldValue(dataLine, "list download row").split(",");
  return requiredWorldValue(
    values[answerColumn],
    `the answer to "${question.text}"`,
  );
};

/** The question's own admin page, open. */
const openQuestionPage = (world: TicketsWorld): Promise<TestBrowser> =>
  openAdminPage(world, `/admin/questions/${askedQuestion(world).id}`);

/** Whether the question's own page offers a way to add answer choices. A
 * written question has none to offer, so its page must not either. */
export const questionPageOffersChoices = async (
  world: TicketsWorld,
): Promise<boolean> =>
  (await openQuestionPage(world)).pageText.includes("Add Answer");

/** The owner takes the question down from its own page, typing text to
 * confirm, and keeps what the site said. */
export const ownerTakesQuestionDown = takesDownFromOwnPage(
  openQuestionPage,
  "Delete Question",
);
