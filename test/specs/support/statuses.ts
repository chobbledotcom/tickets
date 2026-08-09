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
  findsTheWayInFrom,
  ORGANISER,
  openAdminPage,
  opensListAtRow,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  rowsOnList,
} from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { movingRowsOn } from "#test/specs/support/reordering.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  keepWhatTheyWereTold,
  type ReadAboutOneThing,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Where the organiser's own list of states lives. */
const THE_LIST = "/admin/settings/statuses";

/** The jobs a state can hold, in the organiser's own words. Only these exist,
 * so a story naming anything else is a story about a job the site does not
 * have — and a new job is a missing entry below rather than a silent miss. */
type StateJob = "where a paid booking lands" | "where new bookings start";

/** What each job looks like on the pages: the box on the add form that gives
 * it away, and the badge the list puts beside whichever state holds it. */
const JOBS: Record<StateJob, { badge: string; box: string }> = {
  "where a paid booking lands": {
    badge: "statuses.badge_paid",
    box: "is_paid_default",
  },
  "where new bookings start": {
    badge: "statuses.badge_public_default",
    box: "is_public_default",
  },
};

/** A job named by a story, checked against the ones the site really has. The
 * words come out of a Feature file, so they are only a `StateJob` once this
 * has looked. */
const theJob = (job: string): { badge: string; box: string } => {
  const known = JOBS[job as StateJob];
  if (!known) throw new Error(`No state can be "${job}"`);
  return known;
};

/** The organiser's own list of states, open in front of them. */
const openList = (world: TicketsWorld): Promise<TestBrowser> =>
  openAdminPage(world, THE_LIST);

/** What the link into one state's own row looks like: the list's own address
 * with the state's number on the end. */
const INTO_ONE = new RegExp(`^${THE_LIST}/(\\d+)$`);

/** Every state the list offers, in the order it shows them. */
export const statesOffered = async (world: TicketsWorld): Promise<string[]> =>
  rowsOnList((await openList(world)).currentHtml, INTO_ONE).map(
    ({ name }) => name,
  );

/** The list open at one state's own row, or a loud failure — a story that
 * carried on would act on the wrong row, or on none. */
const openAtState = opensListAtRow(THE_LIST, INTO_ONE);

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
  ...(state.job === undefined ? [] : [theJob(state.job).box]),
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

/** Every marker on one state's own row. Read off that state's row alone, so a
 * marker beside somebody else is never taken for this one's.
 *
 * Only the little markers count, not the whole row's words: a state may be
 * called "Paid", and its own name is no evidence that the site marked it as
 * where a paid booking lands. */
const MARKER = /<span class="badge[^"]*">([\s\S]*?)<\/span>/g;

export const markersOnRow: ReadAboutOneThing<string[]> = async (world, name) =>
  [...(await openAtState(world, name)).row.matchAll(MARKER)].map((marker) =>
    marker[1]!.trim(),
  );

/** Whether one state's own row carries a marker. */
const rowShowsBadge = async (
  world: TicketsWorld,
  name: string,
  badge: string,
): Promise<boolean> => (await markersOnRow(world, name)).includes(badge);

/** Whether the list marks one state as holding one job. */
export const listMarksStateAs = (
  world: TicketsWorld,
  name: string,
  job: string,
): Promise<boolean> => rowShowsBadge(world, name, t(theJob(job).badge));

/** Whether the list says a state asks for a deposit, and how much. */
export const listShowsDeposit = (
  world: TicketsWorld,
  name: string,
  amount: string,
): Promise<boolean> =>
  rowShowsBadge(world, name, t("statuses.badge_reservation", { amount }));

/** The link into one state's own page, read off that state's own row. A link,
 * not any mention of the address: a state whose row lost its way in is one the
 * organiser cannot reach either. */
const linkIntoState = findsTheWayInFrom(openAtState);

/** The organiser takes a state away, following every way in they really have —
 * the link on their list, the delete link behind that page's Actions tab —
 * then typing a name to confirm. */
const takesStateAway: TakesOneThingDown = takesDownFromList(linkIntoState, {
  deleteLinkKey: "statuses.delete_button",
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
