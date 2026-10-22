// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
// jscpd:ignore-end

import { openAdminPage } from "#test/specs/support/browser.ts";
import { recordPath } from "#test/specs/support/door.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

When(
  "the organiser opens the {word} door",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    await openAdminPage(
      this,
      recordPath("listing", listingIdNamed(this, listing), "scanner"),
    );
  },
);

Then(
  "the {word} door page carries its offline switch and waiting count",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    const browser = await openAdminPage(
      this,
      recordPath("listing", listingIdNamed(this, listing), "scanner"),
    );
    const html = browser.currentHtml;
    // The switch sits beside the camera button, worded plainly and styled
    // quietly; the banner and the waiting line speak while the door works
    // offline.
    expect(html).toContain('id="scanner-offline-toggle"');
    expect(html).toMatch(
      /<button[^>]*class="[^"]*\bmuted\b[^"]*"[^>]*id="scanner-offline-toggle"/,
    );
    expect(html).toContain('id="scanner-offline-banner"');
    expect(html).toContain('id="scanner-offline-queue"');
    expect(html).toContain("Offline mode: off");
  },
);
