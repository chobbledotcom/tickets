/**
 * End-to-end no-quantity (quantity = 0) sentinel flows, driven through the real
 * admin UI with TestBrowser (links followed by text, forms submitted by button).
 *
 * The sentinel rule: a quantity-0 line is kept in the admin record views but has
 * no live customer ticket. These specs flip lines via the editor's actual "no
 * quantity" box and assert both directions — what stays (admin) and what goes
 * (the customer /t page and the live ticket affordances).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { awaitTestRequest } from "#test-utils";
import {
  addAttendee,
  createListing,
  gotoListing,
  openAttendeeEditor,
  setupAndLogin,
  ticketTokenOnPage,
  useE2eBrowser,
} from "#test-utils/e2e.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** Fresh logged-in admin with one listing holding one real booking (quantity 2).
 * Returns the listing id and the booking's customer ticket token. */
const bookedListing = async (
  browser: TestBrowser,
  { listing = "Workshop", guest = "Guest" } = {},
): Promise<{ listingId: string; token: string }> => {
  await setupAndLogin(browser);
  const listingId = await createListing(browser, { name: listing });
  await addAttendee(browser, { name: guest, quantity: "2" });
  expect(browser.containsText(`Added ${guest}`)).toBe(true);
  return { listingId, token: ticketTokenOnPage(browser) };
};

/** Flip the attendee's line for `listingId` to a no-quantity sentinel via the
 * editor's "no quantity" box; the rest of the form is preserved. */
const markNoQuantity = (
  browser: TestBrowser,
  listingId: string,
): Promise<void> =>
  browser.submitForm({ [`noqty_${listingId}`]: "on" }, "Save Attendee");

/** Restore the attendee's line for `listingId` to a real quantity (un-ticks the
 * no-quantity box by submitting it empty). */
const restoreQuantity = (
  browser: TestBrowser,
  listingId: string,
  quantity: number,
): Promise<void> =>
  browser.submitForm(
    { [`noqty_${listingId}`]: "", [`qty_${listingId}`]: String(quantity) },
    "Save Attendee",
  );

/** Status code of the customer ticket page for a token. */
const ticketStatus = async (token: string): Promise<number> =>
  (await awaitTestRequest(`/t/${token}`)).status;

describe("e2e: no-quantity sentinel flow", () => {
  const ctx = useE2eBrowser();

  test("flipping a line to no-quantity keeps it in admin but removes the customer ticket", async () => {
    const browser = ctx.browser;
    const { listingId, token } = await bookedListing(browser, {
      guest: "Ghost Guest",
    });
    // The real booking has a live customer ticket showing the listing.
    expect(await ticketStatus(token)).toBe(200);

    await openAttendeeEditor(browser);
    await markNoQuantity(browser, listingId);
    expect(browser.containsText("Updated Ghost Guest")).toBe(true);

    // RIGHT places — the ghost stays in the admin record views: still on the
    // listing roster, flagged with the no-quantity badge.
    await browser.visit(`/admin/listing/${listingId}`);
    expect(browser.containsText("Ghost Guest")).toBe(true);
    expect(browser.containsText("No quantity")).toBe(true);

    // WRONG places — the customer ticket 404s and the roster no longer offers
    // the live /t link (the badge stands in its place).
    expect(await ticketStatus(token)).toBe(404);
    expect(browser.currentHtml).not.toContain(`/t/${token}`);
  });

  test("un-flipping a no-quantity line restores the customer ticket", async () => {
    const browser = ctx.browser;
    const { listingId, token } = await bookedListing(browser, {
      guest: "Returning Guest",
    });

    await openAttendeeEditor(browser);
    await markNoQuantity(browser, listingId);
    expect(await ticketStatus(token)).toBe(404);

    // Restore the line to a real quantity → the ticket comes back, and the
    // roster offers the live link again. (Metamorphic: flip then un-flip is a
    // no-op for the customer-facing ticket.)
    await restoreQuantity(browser, listingId, 2);
    expect(browser.containsText("Updated Returning Guest")).toBe(true);
    const restored = await awaitTestRequest(`/t/${token}`);
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain("Workshop");
    await browser.visit(`/admin/listing/${listingId}`);
    expect(browser.currentHtml).toContain(`/t/${token}`);
  });

  test("a mixed attendee keeps the real ticket and excludes the ghost listing", async () => {
    const browser = ctx.browser;
    await setupAndLogin(browser);
    const realId = await createListing(browser, { name: "RealShow" });
    const ghostId = await createListing(browser, { name: "GhostShow" });

    // Book the attendee on RealShow, then add GhostShow as a no-quantity line.
    await gotoListing(browser, "RealShow");
    await addAttendee(browser, { name: "Mixed Guest", quantity: "2" });
    const token = ticketTokenOnPage(browser);
    await openAttendeeEditor(browser);
    await markNoQuantity(browser, ghostId);
    expect(browser.containsText("Updated Mixed Guest")).toBe(true);

    // The customer ticket renders the real listing only — never the ghost.
    const ticket = await awaitTestRequest(`/t/${token}`);
    expect(ticket.status).toBe(200);
    const body = await ticket.text();
    expect(body).toContain("RealShow");
    expect(body).not.toContain("GhostShow");

    // Admin: RealShow's roster offers the live ticket link; GhostShow's roster
    // lists the same attendee with the no-quantity badge and no link.
    await browser.visit(`/admin/listing/${realId}`);
    expect(browser.currentHtml).toContain(`/t/${token}`);
    await browser.visit(`/admin/listing/${ghostId}`);
    expect(browser.containsText("Mixed Guest")).toBe(true);
    expect(browser.containsText("No quantity")).toBe(true);
    expect(browser.currentHtml).not.toContain(`/t/${token}`);
  });
});
