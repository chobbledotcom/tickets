/**
 * The set-up the book-correcting stories share. Every correction is made the
 * way an organiser makes it — on the page that offers it — so a page that stops
 * offering a correction fails the story rather than being worked around.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { WRITEOFF } from "#accounting/accounts.ts";
import { accountBalance } from "#accounting/queries.ts";
import { submitRenderedAdminForm } from "#test/specs/support/browser.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import { worldBalance } from "#test/specs/support/money-reads.ts";
import {
  type ActOnTheStory,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { postModifierLeg } from "#test-utils/ledger.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
// jscpd:ignore-end

/** What the site holds and what it has parked, before a correction is made, so
 * a story can prove a correction moved one and not the other. */
export const rememberMoneyBefore: ActOnTheStory = async (world) => {
  world.cashBefore = await worldBalance();
  world.writeoffBefore = await accountBalance(WRITEOFF);
};

/** The cash the site held before the correction. */
export const cashBefore = (world: TicketsWorld): number =>
  requiredWorldValue(world.cashBefore, "the cash before the correction");

/** An extra charge that has already earned something. */
export const surchargeEarning = async (
  world: TicketsWorld,
  name: string,
  earned: string,
): Promise<void> => {
  const modifier = await insertModifier({
    calcValue: minorUnits(earned),
    name,
  });
  world.modifierId = modifier.id;
  await postModifierLeg({ delta: minorUnits(earned), modifierId: modifier.id });
};

/** The extra charge the story is about. */
export const surchargeId = (world: TicketsWorld): number =>
  requiredWorldValue(world.modifierId, "the extra charge");

/** Type a new figure into a correction form the page offers, and check the
 * organiser is told it saved — a refused save redirects just the same. */
export const correctOnPage = async (
  world: TicketsWorld,
  page: string,
  field: string,
  amount: string,
  told: string,
): Promise<void> => {
  const browser = await submitRenderedAdminForm(
    world,
    page,
    "Save income correction",
    { [field]: amount },
  );
  expect(browser.containsText(told)).toBe(true);
};

/** Add a ledger entry against a booking, from the page that offers it. */
export const addBalanceEntry = async (
  world: TicketsWorld,
  attendeeId: number,
  entryType: string,
  amount: string,
): Promise<void> => {
  await submitRenderedAdminForm(
    world,
    `/admin/ledger/attendee/${attendeeId}/add`,
    "Add money change",
    { amount, entry_type: entryType, occurred_at: "2026-06-22T12:00" },
  );
};
