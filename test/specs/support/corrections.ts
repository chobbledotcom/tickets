/**
 * The set-up the book-correcting stories share. Every correction is made the
 * way an organiser makes it — on the page that offers it — so a page that stops
 * offering a correction fails the story rather than being worked around.
 */

import { expect } from "@std/expect";
import { WRITEOFF } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { postModifierLeg } from "#test-utils/ledger.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { worldBalance } from "#test-utils/money/reads.ts";

/** What the site holds and what it has parked, before a correction is made, so
 * a story can prove a correction moved one and not the other. */
export const rememberMoneyBefore = async (
  world: TicketsWorld,
): Promise<void> => {
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
  const browser = await adminBrowser(world);
  await browser.visit(page);
  // The page must offer the correction box itself; the browser posts the
  // form's own action and token, so a broken form fails here.
  expect(browser.currentHtml).toContain(`id="${field}"`);
  await browser.submitForm({ [field]: amount }, "Save income correction");
  expect(browser.containsText(told)).toBe(true);
};

/** Add a ledger entry against a booking, from the page that offers it. */
export const addBalanceEntry = async (
  world: TicketsWorld,
  attendeeId: number,
  entryType: string,
  amount: string,
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/ledger/attendee/${attendeeId}/add`);
  expect(browser.currentHtml).toContain('name="entry_type"');
  await browser.submitForm(
    {
      amount,
      entry_type: entryType,
      occurred_at: "2026-06-22T12:00",
    },
    "Add money change",
  );
};
