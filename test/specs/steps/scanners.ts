// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
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
  function (this: TicketsWorld, _who: string, guest: string): Promise<void> {
    return openScannerPage(this, `/checkin/${ticketOf(this, guest)}`).then(
      () => undefined,
    );
  },
);

Then(
  "the {word} door is open for {word}",
  function (this: TicketsWorld, listing: string, _who: string): void {
    // The scanner's own window stands on the door's scanner page: the page
    // carries the door's scan target and answers with the door's own heading.
    const page = scannerBrowser(this).currentHtml;
    expect(page).toContain("data-scan-path=");
    expect(page).toContain(t("admin.scanner.title", { name: listing }));
  },
);

Then(
  "the ticket page offers to check them out",
  function (this: TicketsWorld): void {
    expect(scannerBrowser(this).currentHtml).toContain(
      t("admin.checkin.check_out_all"),
    );
  },
);

When(
  "{word} checks them out",
  function (this: TicketsWorld, _who: string): Promise<void> {
    return fillInAndSend(
      scannerBrowser(this),
      {},
      t("admin.checkin.check_out_all"),
    ).then(() => undefined);
  },
);

Then(
  "the site says they were checked out",
  function (this: TicketsWorld): void {
    // The check-in page answers with its own words, and the person it is
    // about is on the page underneath them.
    expect(scannerBrowser(this).pageText).toContain("Checked out");
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
