/**
 * The record the site keeps about one person, and the organiser's page for
 * putting it right. A contact is found by a one-way code made from their email,
 * so the real address is never stored — every helper here starts from the email
 * the story names and lets the site work that code out.
 */

import { expect } from "@std/expect";
import { execute } from "#shared/db/client.ts";
import {
  type ContactRecord,
  getContactRecord,
  hashEmail,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** What the organiser types into the record's form. Anything left out is sent
 * as the form's own empty value, the way a blank box would be. */
export interface RecordEdit {
  bookedByHand?: string;
  bookedThroughTheSite?: string;
  messages?: string;
  note?: string;
  visits?: string;
}

/** The page for one person's record, found the way the site finds it. */
const pagePath = async (email: string): Promise<string> =>
  `/admin/history/${toContactHashParam(await hashEmail(email))}`;

/** Everything the site has stored about them right now. */
export const recordFor = async (email: string): Promise<ContactRecord> =>
  getContactRecord(await hashEmail(email), await getTestPrivateKey());

/** Someone the site has already seen, with a history behind them. */
export const contactWithHistory = async (
  email: string,
  history: {
    bookedByHand: number;
    bookedThroughTheSite: number;
    lastContacted: string;
    messages: number;
    note: string;
    visits: number;
  },
): Promise<void> => {
  await saveContactRecord(await hashEmail(email), {
    adminBookingCount: history.bookedByHand,
    adminNotes: history.note,
    contactCount: history.messages,
    lastContact: history.lastContacted,
    lastSubject: "Hello",
    publicBookingCount: history.bookedThroughTheSite,
    visits: history.visits,
  });
};

/** A stored record whose note the site can no longer read, with its plain
 * counts intact — the state a half-finished write can leave behind. */
export const unreadableRecord = async (
  email: string,
  counts: {
    bookedByHand: number;
    bookedThroughTheSite: number;
    visits: number;
  },
): Promise<void> => {
  await execute(
    "INSERT INTO contact_preferences (contact_hash, visits, public_booking_count, admin_booking_count, stats_blob, last_activity) VALUES (?, ?, ?, ?, ?, ?)",
    [
      await hashEmail(email),
      counts.visits,
      counts.bookedThroughTheSite,
      counts.bookedByHand,
      "not-valid-ciphertext",
      Date.now(),
    ],
  );
};

/** The organiser opens someone's record. */
export const openRecord = async (
  world: TicketsWorld,
  email: string,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(await pagePath(email));
  return browser;
};

/** The boxes on the page, by the words this file uses for them. */
const BOXES = {
  bookedByHand: "admin_booking_count",
  bookedThroughTheSite: "public_booking_count",
  messages: "messages",
  note: "admin_notes",
  visits: "visits",
} as const;

/** The organiser fills the record's own form in and saves it. Every box has to
 * be on the page, so a form that stops offering one fails the story. */
export const saveRecord = async (
  world: TicketsWorld,
  email: string,
  edit: RecordEdit,
): Promise<TestBrowser> => {
  const browser = await openRecord(world, email);
  const values: Record<string, string> = {};
  for (const [word, box] of Object.entries(BOXES)) {
    const typed = edit[word as keyof RecordEdit];
    if (typed === undefined) continue;
    expect(browser.currentHtml).toContain(`name="${box}"`);
    values[box] = typed;
  }
  await browser.submitForm(values, "Save record");
  return browser;
};

/** What one of the record's boxes is filled in with when the page is opened. */
export const boxShows = (
  browser: TestBrowser,
  word: keyof typeof BOXES,
  value: string,
): void => {
  expect(browser.currentHtml).toMatch(
    new RegExp(`name="${BOXES[word]}"[^>]*value="${value}"`),
  );
};
