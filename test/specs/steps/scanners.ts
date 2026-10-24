// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
// jscpd:ignore-end

import { t } from "#i18n";
import { ticketOf } from "#test/specs/support/door.ts";
import { privatePagePath } from "#test/specs/support/editors.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  openScannerPage,
  ownerInvitesScanner,
  scanAtDoorAsScanner,
  scannerBrowser,
  scannerFollowsInvite,
  scannerLogsIn,
  signedInScanner,
} from "#test/specs/support/scanners.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

Given(
  "the owner invites {word} to work a door",
  function (this: TicketsWorld, who: string): Promise<void> {
    return ownerInvitesScanner(this, who);
  },
);

When(
  "{word} follows the door invite and chooses a password",
  function (this: TicketsWorld, _who: string): Promise<void> {
    return scannerFollowsInvite(this);
  },
);

When(
  "{word} signs in",
  function (this: TicketsWorld, who: string): Promise<void> {
    return scannerLogsIn(this, who);
  },
);

Given(
  "{word} is signed in as a scanner",
  function (this: TicketsWorld, who: string): Promise<void> {
    return signedInScanner(this, who);
  },
);

Then(
  "{word} is looking at the doors",
  function (this: TicketsWorld, _who: string): void {
    expect(scannerBrowser(this).currentUrl.replace(/\/$/, "")).toBe(
      "/admin/scanner",
    );
  },
);

When(
  "{word} opens the {word} door",
  async function (
    this: TicketsWorld,
    _who: string,
    listing: string,
  ): Promise<void> {
    // The doors page is the scanner's way in: the door is opened by
    // following its link there, so a door the page stopped listing fails
    // the story instead of being jumped to.
    await openScannerPage(this, "/admin/scanner");
    await scannerBrowser(this).clickLink(listing);
  },
);

When(
  "{word} reads {word}'s ticket at the {word} door",
  async function (
    this: TicketsWorld,
    _who: string,
    guest: string,
    listing: string,
  ): Promise<void> {
    this.doorAnswer = await scanAtDoorAsScanner(
      this,
      listing,
      ticketOf(this, guest),
    );
  },
);

When(
  "{word} reads the QR on {word}'s ticket",
  async function (
    this: TicketsWorld,
    _who: string,
    guest: string,
  ): Promise<void> {
    await openScannerPage(this, `/checkin/${ticketOf(this, guest)}`);
  },
);

Then(
  "the {word} door is open for {word}",
  function (this: TicketsWorld, listing: string, _who: string): void {
    // The scanner's own window stands on the door's scanner page: the page
    // carries the door's scan target and answers with the door's own heading.
    const page = scannerBrowser(this).currentHtml;
    assertStringIncludes(page, "data-scan-path=");
    assertStringIncludes(page, t("admin.scanner.title", { name: listing }));
  },
);

Then(
  "the door page offers an offline mode switch that starts off",
  function (this: TicketsWorld): void {
    const page = scannerBrowser(this).currentHtml;
    // This harness serves the page and never runs its script, so the step
    // reads the switch the door worker sees: the site's own label, and
    // the off state the page serves it in.
    const toggle = page.match(
      /<button([^>]*)\sid="scanner-offline-toggle"([^>]*)>([^<]*)<\/button>/,
    );
    expect(toggle?.[3]?.trim()).toBe(t("admin.scanner.offline_mode"));
    expect(toggle?.[0]).toContain('aria-pressed="false"');
  },
);

Then(
  "the door page keeps a place that will list the queued check-ins",
  function (this: TicketsWorld): void {
    const page = scannerBrowser(this).currentHtml;
    // This harness serves the page and never runs its script, so the step
    // reads the promise the served page makes: the panel whose polite
    // live region will carry the queued count, and the list the queued
    // check-ins will fill once offline mode turns on.
    const queue = page.match(
      /<div class="hidden" id="scanner-queue">([\s\S]*?)<\/div>/,
    );
    expect(queue?.[1]).toContain(
      '<p aria-live="polite" id="scanner-queue-summary"></p>',
    );
    expect(queue?.[1]).toContain('<ul id="scanner-queue-items"></ul>');
  },
);

Then(
  "the door page serves the words it shows when the connection drops and when offline mode is on",
  function (this: TicketsWorld): void {
    const page = scannerBrowser(this).currentHtml;
    // The harness never runs the page's script, so the step reads the two
    // banner wordings where the page serves them.
    assertStringIncludes(
      page,
      `data-message-offline-banner-auto="${t(
        "admin.scanner.offline_banner_auto",
      )}"`,
    );
    assertStringIncludes(
      page,
      `data-message-offline-banner-manual="${t(
        "admin.scanner.offline_banner_manual",
      )}"`,
    );
  },
);

Then(
  "the ticket page offers to check them out",
  function (this: TicketsWorld): void {
    assertStringIncludes(
      scannerBrowser(this).currentHtml,
      t("admin.checkin.check_out_all"),
    );
  },
);

When(
  "{word} checks them out",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    await fillInAndSend(
      scannerBrowser(this),
      {},
      t("admin.checkin.check_out_all"),
    );
  },
);

Then(
  "the site says they were checked out",
  function (this: TicketsWorld): void {
    // The check-in page answers with its own words, and the person it is
    // about is on the page underneath them.
    assertStringIncludes(scannerBrowser(this).pageText, "Checked out");
  },
);

When(
  "{word} asks to open the {string} page",
  async function (
    this: TicketsWorld,
    _who: string,
    page: string,
  ): Promise<void> {
    this.scannerAnswer = await scannerBrowser(this).statusOf(
      privatePagePath(page),
    );
  },
);

Then(
  "{word} is turned away",
  function (this: TicketsWorld, _who: string): void {
    // Refused outright, not merely sent somewhere friendlier: a redirect
    // would leave the page reachable by anyone who followed it back.
    expect(this.scannerAnswer).toBe(403);
  },
);

When(
  "{word} says {int} ticket(s) for {word} at the {word} door",
  async function (
    this: TicketsWorld,
    _who: string,
    tickets: number,
    guest: string,
    listing: string,
  ): Promise<void> {
    // The door must have asked: answering a question never put would hide a
    // door that stopped asking how many.
    expect(this.doorAnswer?.status).toBe("select_quantity");
    this.doorAnswer = await scanAtDoorAsScanner(
      this,
      listing,
      ticketOf(this, guest),
      { tickets },
    );
  },
);

Then(
  "the ticket page says {int} of {int} are checked in",
  function (this: TicketsWorld, admitted: number, total: number): void {
    assertStringIncludes(
      scannerBrowser(this).pageText,
      t("attendee_form.checked_in_count", { count: admitted, total }),
    );
  },
);

Then(
  "the ticket page offers to check them in and out",
  function (this: TicketsWorld): void {
    const page = scannerBrowser(this).currentHtml;
    assertStringIncludes(page, t("admin.checkin.check_in_all"));
    assertStringIncludes(page, t("admin.checkin.check_out_all"));
  },
);
