/**
 * The states a booking can be in, as the organiser writes them.
 *
 * Everything goes through the list the organiser is looking at: a state is
 * added by following the page's own Add link and filling in its form, taken
 * away by typing its name, and moved by the arrow on its own row. The list is
 * also where every answer is read back from, so a state the page stopped
 * showing is one the story cannot find either.
 */

import { expect } from "@std/expect";
// jscpd:ignore-start
import { t } from "#i18n";
import {
  type FindsTheWayIn,
  ORGANISER,
  openAdminPage,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  fillInAndSend,
} from "#test/specs/support/form-controls.ts";
import { movingRowsOn } from "#test/specs/support/reordering.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Where the organiser's own list of states lives. */
const THE_LIST = "/admin/settings/statuses";

/** The two jobs a state can hold, in the story's words and in the box on the
 * form that gives it away. Only these two exist, so a story naming anything
 * else is a story about a job the site does not have. */
const BOX_FOR_JOB: Record<string, string> = {
  "where a paid booking lands": "is_paid_default",
  "where new bookings start": "is_public_default",
};

/** The badge the list puts beside the state holding one job. */
const BADGE_FOR_JOB: Record<string, string> = {
  "where a paid booking lands": "statuses.badge_paid",
  "where new bookings start": "statuses.badge_public_default",
};

const boxForJob = (job: string): string => {
  const box = BOX_FOR_JOB[job];
  if (!box) throw new Error(`No state can be "${job}"`);
  return box;
};

/** The organiser's own list of states, open in front of them. */
const openList = (world: TicketsWorld): Promise<TestBrowser> =>
  openAdminPage(world, THE_LIST);

/** One row of the list as the organiser sees it: the state's name, the number
 * the site files it under, and the markup of the row it sits in — so a badge
 * on somebody else's row is never read as this one's. */
interface StateOnList {
  id: number;
  name: string;
  row: string;
}

const statesOnList = (html: string): StateOnList[] => {
  const intoOne = new RegExp(`href="${THE_LIST}/(\\d+)"[^>]*>([^<]+)<`);
  const rows: StateOnList[] = [];
  for (const row of html.split("<tr").slice(1)) {
    const into = row.match(intoOne);
    if (into) rows.push({ id: Number(into[1]), name: into[2]!.trim(), row });
  }
  return rows;
};

/** Every state the list offers, in the order it shows them. */
export const statesOffered = async (world: TicketsWorld): Promise<string[]> =>
  statesOnList((await openList(world)).currentHtml).map(({ name }) => name);

/** The list open at one state's own row: the page in front of the organiser
 * and everything the list says about that state. */
type OpensAtOneState = (
  world: TicketsWorld,
  name: string,
) => Promise<StateOnList & { browser: TestBrowser }>;

/** The list open at one state's own row, or a loud failure — a story that
 * carried on would act on the wrong row, or on none. */
const openAtState: OpensAtOneState = async (world, name) => {
  const browser = await openList(world);
  const found = statesOnList(browser.currentHtml).find(
    (state) => state.name === name,
  );
  if (!found) throw new Error(`The list offers no state called "${name}"`);
  return { ...found, browser };
};

/** What the organiser fills in when adding a state. A deposit and a job are
 * each only sometimes part of it, so a story says which it means. */
export interface NewState {
  deposit?: string;
  job?: string;
  meansTheBalanceIsPaid?: boolean;
  name: string;
}

/** Each box the new-state form offers to tick, and whether this state wants
 * it. A deposit means ticking the reservation box; a job means ticking that
 * job's own box. */
const boxesToTick = (state: NewState): string[] => [
  ...(state.deposit === undefined ? [] : ["is_reservation"]),
  ...(state.job === undefined ? [] : [boxForJob(state.job)]),
  ...(state.meansTheBalanceIsPaid ? ["is_paid_default"] : []),
];

/** The organiser adds a state, following the Add link on their own list and
 * filling in the form it opens. What they are told is kept, because some of
 * these are meant to be refused. */
export const organiserAddsState = async (
  world: TicketsWorld,
  state: NewState,
): Promise<void> => {
  const browser = await openList(world);
  await browser.clickLink(t("statuses.add_status_button"));
  const html = browser.currentHtml;
  const ticked = Object.fromEntries(
    boxesToTick(state).map((box) => [box, [checkboxValueOffered(html, box)]]),
  );
  await fillInAndSend(
    browser,
    {
      name: state.name,
      ...(state.deposit === undefined
        ? {}
        : { reservation_amount: state.deposit }),
    },
    t("statuses.form_create_button"),
    ticked,
  );
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
};

/** Whether the list marks one state as holding one job, read off that state's
 * own row. */
export const listMarksStateAs = async (
  world: TicketsWorld,
  name: string,
  job: string,
): Promise<boolean> => {
  const badge = BADGE_FOR_JOB[job];
  if (!badge) throw new Error(`No state can be "${job}"`);
  return (await openAtState(world, name)).row.includes(t(badge));
};

/** Whether the list says a state asks for a deposit, and how much. */
export const listShowsDeposit = async (
  world: TicketsWorld,
  name: string,
  amount: string,
): Promise<boolean> =>
  (await openAtState(world, name)).row.includes(
    t("statuses.badge_reservation", { amount }),
  );

/** The link into one state's own page, read off the organiser's list. A link,
 * not any mention of the address: a state whose row lost its way in is one the
 * organiser cannot reach either. */
const linkIntoState: FindsTheWayIn = async (world, name) => {
  const { browser, id } = await openAtState(world, name);
  const into = `${THE_LIST}/${id}`;
  return browser.links.find(({ href }) => href === into)?.href ?? null;
};

/** The organiser takes a state away, following every way in they really have —
 * the link on their list, the delete link behind that page's Actions tab —
 * then typing a name to confirm. */
const takesStateAway: TakesOneThingDown = takesDownFromList(linkIntoState, {
  deleteLinkKey: "statuses.delete_button",
  missing: (name) => `The list offers no way into the state "${name}"`,
  submitKey: "statuses.delete_button",
});

/** What they were told is kept, because most of these are meant to be
 * refused. */
export const organiserTakesStateAway = async (
  world: TicketsWorld,
  name: string,
  typed: string,
): Promise<void> => {
  keepWhatTheyWereTold(
    world,
    ORGANISER,
    await takesStateAway(world, name, typed),
  );
};

/** The arrows the organiser's list offers for moving one state. */
const stateArrows = movingRowsOn(THE_LIST, openAtState);

/** The organiser moves one state a step up their list. */
export const organiserMovesStateUp: ActOnOneThing = (world, name) =>
  stateArrows.move(world, name, "up");

/** Whether the list offers to move one state up at all. Its absence is how the
 * site says a state is already at the top. */
export const stateIsOfferedAMoveUp: AsksAboutOneThing = (world, name) =>
  stateArrows.canMove(world, name, "up");

/** A state the story needs to exist before the rule it is about. The add has
 * to have worked, or the rule it feeds proves nothing. */
export const organiserHasAddedState: ActOnOneThing = async (world, name) => {
  await organiserAddsState(world, { name });
  expect(await statesOffered(world)).toContain(name);
};
