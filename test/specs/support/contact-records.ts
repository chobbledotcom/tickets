/**
 * The record the site keeps about one person, and the organiser's page for
 * putting it right. A contact is found by a one-way code made from their email,
 * so the real address is never stored — every helper here starts from the email
 * the story names and lets the site work that code out.
 */

import { expect } from "@std/expect";
import { mapNotNullish } from "#fp";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { execute } from "#shared/db/client.ts";
import {
  type ContactRecord,
  getContactRecord,
  hashEmail,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** What the organiser types into the record's form. A box left out here keeps
 * whatever the page already had in it, the way it would for a person who edits
 * one field and presses save. */
interface RecordEdit {
  bookedByHand?: string;
  bookedThroughTheSite?: string;
  messages?: string;
  note?: string;
  visits?: string;
}

/** Where one person's record lives, under the one-way code made from their
 *  email rather than the address itself. */
const recordPath = (code: string): string => `/admin/history/${code}`;

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

/** The organiser opens someone's record. The address it lives at is kept on
 *  the world because it is made from a one-way code, not from the email, so an
 *  evidence capture has no path it could write by hand. */
export const openRecord = async (
  world: TicketsWorld,
  email: string,
): Promise<TestBrowser> => {
  const code = toContactHashParam(await hashEmail(email));
  leaveEvidencePage(
    world,
    ["contact-record", "record-put-right", "record-repaired"],
    recordPath(code),
  );
  return openAdminPage(world, recordPath(code));
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
 * be on the page — including the ones this edit does not touch, because those
 * are carried forward from what the page showed, so a box that quietly vanished
 * would be saved as nothing without anyone noticing. What the organiser types
 * must also be something the box itself would accept, so a story can never send
 * what a real form would block. */
export const saveRecord = async (
  world: TicketsWorld,
  email: string,
  edit: RecordEdit,
): Promise<TestBrowser> => {
  const browser = await openRecord(world, email);
  for (const box of Object.values(BOXES)) {
    expect(browser.currentHtml).toContain(`name="${box}"`);
  }
  const values = Object.fromEntries(
    mapNotNullish(([word, box]: [string, string]) => {
      const typed = edit[word as keyof RecordEdit];
      if (typed === undefined) return;
      expect(whyValueCannotBeSent(browser.currentHtml, box, typed)).toBeNull();
      return [box, typed] as const;
    })(Object.entries(BOXES)),
  );
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
