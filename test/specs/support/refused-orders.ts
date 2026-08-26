/**
 * The machinery the refused-order stories share: filling a page in and
 * holding the unsent order, reading the refused page back, and putting the
 * things those stories sell on sale. The steps in
 * `test/specs/steps/refused-orders.ts` stay thin over these.
 */

// jscpd:ignore-start
import {
  attribute,
  boxFor,
} from "#test/specs/support/form-controls/reading.ts";
import {
  listingNamed,
  putsOnSaleByTheDay,
} from "#test/specs/support/listings.ts";
import {
  type BookingAttempt,
  type BookingChoices,
  daysOfferedFor,
  type OrderInHand,
  type OrderLine,
  visitorFillsInOrder,
} from "#test/specs/support/public-booking.ts";
import { ownPageOrder } from "#test/specs/support/sales-pages.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
// jscpd:ignore-end

export const THE_CUSTOMER = { email: "jane@example.com", who: "Jane Doe" };
export const SOMEONE_QUICKER = {
  email: "quicker@example.com",
  who: "Kit Quick",
};

/** The question this scenario's listing asks, or a loud failure. */
export type QuestionAsked = NonNullable<TicketsWorld["questionChoices"]>;
export const questionAsked = (world: TicketsWorld): QuestionAsked =>
  requiredWorldValue(world.questionChoices, "the question the listing asks");

/** The choice sent by answering with these words, or a loud failure when the
 * question never offered them. */
export const choiceCalled = (asked: QuestionAsked, label: string): string =>
  requiredWorldValue(asked.byLabel[label], `the "${label}" answer`);

/** A choice that is not the customer's own, so a tick that survives the
 * refusal can only be theirs. */
export const choiceUnlikeTheirs = (
  asked: QuestionAsked,
  theirs?: string,
): string => {
  const other = Object.values(asked.byLabel).find(
    (choice) => choice !== theirs,
  );
  if (!other) throw new Error("The question offers no second answer to pick");
  return other;
};

/** Fill a served page in and keep the unsent order, with what was typed into
 * it, so the story can race somebody past it and read the refill back. */
export const fillsIn = async (
  world: TicketsWorld,
  path: string,
  lines: OrderLine[],
  choices: BookingChoices,
): Promise<void> => {
  const { press } = await visitorFillsInOrder(path, lines, choices);
  world.orderFilledIn = { choices, lines, press };
};

export const orderInHand = (world: TicketsWorld): OrderInHand =>
  requiredWorldValue(world.orderFilledIn, "the filled-in order");

export const sentOrder = (world: TicketsWorld): BookingAttempt =>
  requiredWorldValue(world.orderSent, "what the site said to the order");

/** The page the refusal handed back, with the typed values re-filled. */
export const refillPage = (world: TicketsWorld): string =>
  sentOrder(world).browser.currentHtml;

/** What a box on the refused page still holds, or a loud failure when the
 * page stopped rendering the box at all. */
export const wordsInBox = (html: string, field: string): string => {
  const box = boxFor(html, field);
  if (!box) throw new Error(`The page has no ${field} box`);
  return attribute(box, "value") ?? "";
};

/** A thing booked by the day, remembered by name, with the extras a story's
 * own listing needs — a chosen price, a bigger order. */
export const sellDayBookedThing = async (
  world: TicketsWorld,
  name: string,
  placesADay: number,
  extras: TestListingOverrides = {},
): Promise<void> => {
  await putsOnSaleByTheDay(world, name, {
    maxAttendees: placesADay,
    maxQuantity: placesADay,
    thankYouUrl: "",
    ...extras,
  });
};

/** The first day a listing's own page offers, or a loud failure — "a day
 * soon" in a story is a day the site really offers. */
export const firstDayOffered = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const [day] = await daysOfferedFor(listingNamed(world, name));
  if (!day) throw new Error(`The ${name} offers no day to book`);
  return day;
};

/** Fill one listing's own page in for the customer: the line for that
 * listing, plus whatever extra choices the scenario adds on top of the
 * customer's contact details. Every "filled the X page in" step is one call
 * to this, so the fill itself lives in one place. */
export const fillsOwnPageIn = async (
  world: TicketsWorld,
  name: string,
  line: Omit<OrderLine, "listing">,
  extras: Partial<BookingChoices>,
): Promise<void> => {
  await fillsIn(world, ...ownPageOrder(world, name, line), {
    ...THE_CUSTOMER,
    ...extras,
  });
};
