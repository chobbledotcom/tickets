/**
 * Questions an owner puts on booking, and what buyers say back. The buyer's
 * half always drives the real public page, because the question is only worth
 * asking if it renders where a buyer would answer it.
 */

// jscpd:ignore-start
import { assertStringIncludes } from "@std/assert";
import { parse } from "@std/csv/parse";
import {
  adminBrowser,
  type OpensAtOneRow,
  ORGANISER,
  openAsNewcomer,
  opensAdminPageAt,
  takesDownFromOwnPage,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  listingNamed,
  tickOnListingTab,
} from "#test/specs/support/listings.ts";
import { movingRowsOn } from "#test/specs/support/reordering.ts";
import {
  type ActOnOneThing,
  type ReadAboutOneThing,
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** What the owner was last told, or a loud failure when nothing was said. */
export const ownerLastTold = (world: TicketsWorld): string =>
  whatTheyWereTold(world, ORGANISER);

/** The question this story asked, or a loud failure when it never asked one. */
export const askedQuestion = (
  world: TicketsWorld,
): { id: number; text: string } =>
  requiredWorldValue(world.buyerQuestion, "the question the owner asked");

/** The owner writes a question, of either kind, and lands on its own page.
 * The id is read from where the site sent them, so everything later acts on
 * the question the site really made. */
const ownerWritesQuestion = (
  world: TicketsWorld,
  text: string,
  displayType: "radio" | "free_text",
): Promise<TestBrowser> =>
  withAdminPage(world, "/admin/questions", async (browser) => {
    await fillInAndSend(
      browser,
      { display_type: displayType, text },
      "Add question",
    );
    const id = browser.currentUrl.match(/\/admin\/questions\/(\d+)/)?.[1];
    world.buyerQuestion = {
      id: Number(requiredWorldValue(id, `the page for the question "${text}"`)),
      text,
    };
    return browser;
  });

/** Tick the question on one listing's own questions tab. */
const ownerAssignsQuestionTo: ActOnOneThing = (world, listingName) =>
  tickOnListingTab(
    world,
    listingName,
    "questions",
    "question_ids",
    askedQuestion(world).id,
    "Questions updated",
  );

/** The shape of asking a choice question: one listing, one text, its
 * answers. */
type AsksAChoiceQuestion = (
  world: TicketsWorld,
  listingName: string,
  text: string,
  answers: string[],
) => Promise<void>;

/** A choice question with its answers, asked of one listing's buyers. */
export const ownerAsksChoiceQuestion: AsksAChoiceQuestion = async (
  world,
  listingName,
  text,
  answers,
) => {
  const browser = await ownerWritesQuestion(world, text, "radio");
  for (const answer of answers) {
    await fillInAndSend(browser, { text: answer }, "Add answer");
  }
  for (const answer of answers) {
    assertStringIncludes(browser.pageText, answer);
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
export const visitorOpensBooking: ReadAboutOneThing<TestBrowser> = async (
  world,
  listingName,
) => openAsNewcomer(`/ticket/${listingNamed(world, listingName).slug}`);

/** The field the served page offers for this question, or a loud failure —
 * asserting on a page that stopped asking would prove nothing. */
export const questionFieldOn = (
  world: TicketsWorld,
  browser: TestBrowser,
): string => {
  const name = `question_${askedQuestion(world).id}`;
  assertStringIncludes(browser.currentHtml, `name="${name}"`);
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
  await fillInAndSend(
    browser,
    {
      email: "buyer@example.com",
      name: "Casey Buyer",
      [`quantity_${listingNamed(world, listingName).id}`]: "1",
      [questionFieldOn(world, browser)]: answer,
    },
    "Continue",
  );
  assertStringIncludes(browser.pageText, "Thank you for your order");
};

/** What the owner's list download says this booking answered. The download is
 * where every answer ends up, whichever kind of question it came from. */
export const answerInListDownload: ReadAboutOneThing = async (
  world,
  listingName,
) => {
  const listing = listingNamed(world, listingName);
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${listing.id}/attendees`);
  await browser.clickLink("Export CSV");
  // A real CSV parse, so an answer holding a comma or a quote still lands in
  // its own column rather than spilling into the next one.
  const rows = parse(browser.currentHtml);
  const columns = requiredWorldValue(rows[0], "list download header");
  const question = askedQuestion(world);
  const answerColumn = columns.findIndex((column) =>
    column.includes(question.text),
  );
  if (answerColumn === -1) {
    throw new Error(`The list download has no column for "${question.text}"`);
  }
  const values = requiredWorldValue(rows[1], "list download row");
  return requiredWorldValue(
    values[answerColumn],
    `the answer to "${question.text}"`,
  );
};

/** The question's own admin page, open. */
const openQuestionPage = opensAdminPageAt(
  (world) => `/admin/questions/${askedQuestion(world).id}`,
);

/** Whether the question's own page offers a way to add answer choices. A
 * written question has none to offer, so its page must not either. */
export const questionPageOffersChoices = async (
  world: TicketsWorld,
): Promise<boolean> =>
  (await openQuestionPage(world)).pageText.includes("Add answer");

/** The owner takes the question down from its own page, typing text to
 * confirm, and keeps what the site said. */
export const ownerTakesQuestionDown = takesDownFromOwnPage(
  openQuestionPage,
  "Delete question",
);

/** Run a question-asking step and keep the question the story was acting on
 * in place, recording the one just asked as another asked question. */
const askingAnother =
  (ask: AsksAChoiceQuestion): AsksAChoiceQuestion =>
  async (world, listingName, text, answers) => {
    const asked = requiredWorldValue(
      world.buyerQuestion,
      "the question the story acts on",
    );
    await ask(world, listingName, text, answers);
    world.otherBuyerQuestions = [
      ...(world.otherBuyerQuestions ?? []),
      requiredWorldValue(world.buyerQuestion, `the question "${text}"`),
    ];
    world.buyerQuestion = asked;
  };

/** A second choice question with its answers, asked without disturbing the
 * question the story is acting on. */
export const ownerAsksAnotherChoiceQuestion: AsksAChoiceQuestion =
  askingAnother(ownerAsksChoiceQuestion);

/** The id of the question the story named by its text. */
const questionIdFor = (world: TicketsWorld, text: string): number => {
  const asked = [world.buyerQuestion, ...(world.otherBuyerQuestions ?? [])]
    .filter((question) => question !== undefined)
    .find((question) => question.text === text);
  return requiredWorldValue(
    asked?.id,
    `the question the owner asked with the text "${text}"`,
  );
};

/** The question's page, open at one answer's row: the page somebody is
 * looking at, the answer's id, and that row's own markup. */
const openAtAnswer: OpensAtOneRow = async (world, name) => {
  const browser = await openQuestionPage(world);
  const row = browser.currentHtml
    .split("<tr")
    .slice(1)
    .map((part) => part.slice(0, part.indexOf("</tr>")))
    .find((part) => part.includes(`>${name}</`));
  if (row === undefined) {
    throw new Error(`The question's page shows no answer named "${name}"`);
  }
  const id = row.match(/\/answers\/(\d+)\//)?.[1];
  return {
    browser,
    id: Number(requiredWorldValue(id, `the row for the answer "${name}"`)),
    name,
    row,
    wayIn: `/admin/questions/${askedQuestion(world).id}/answers/edit`,
  };
};

/** The arrows the question's page offers for moving one answer. */
const answerArrows = movingRowsOn(
  (world) => `/admin/questions/${askedQuestion(world).id}/answers`,
  openAtAnswer,
);

/** The owner adds one answer choice on the question's own page. */
export const ownerAddsAnswer = async (
  world: TicketsWorld,
  answer: string,
): Promise<void> => {
  await fillInAndSend(
    await openQuestionPage(world),
    { text: answer },
    "Add answer",
  );
};

/** The owner moves one answer a step up the question's page. */
export const ownerMovesAnswerUp: ActOnOneThing = (world, name) =>
  answerArrows.move(world, name, "up");

/** Whether the question's page still offers to move an answer up. A top
 * answer is one nobody could move further, so the page offers no arrow. */
export const answerOffersMoveUp = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => answerArrows.canMove(world, name, "up");

/** The answers one served booking page offers for a named question, in the
 * order the page renders them. */
export const offeredAnswersInOrder = async (
  world: TicketsWorld,
  listingName: string,
  text: string,
): Promise<string[]> => {
  const browser = await visitorOpensBooking(world, listingName);
  const field = `question_${questionIdFor(world, text)}`;
  assertStringIncludes(browser.currentHtml, `name="${field}"`);
  // Each answer renders as one labelled radio under the question's name, in
  // the order the site put them in, so the labels themselves are the order a
  // buyer reads. The input is a void element: the served markup closes it
  // with `>`, not `/>`.
  return [
    ...browser.currentHtml.matchAll(
      new RegExp(`name="${field}"[^>]*>\\s*([^<]+?)\\s*</label>`, "g"),
    ),
  ].map((match) => match[1]!.trim());
};
