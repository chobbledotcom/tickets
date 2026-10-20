// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
// jscpd:ignore-end

import { sha256Hex } from "#crypto/sha256.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { recordPath, ticketOf } from "#test/specs/support/door.ts";
import {
  replayQueuedCheckIn,
  savedListAtDoor,
} from "#test/specs/support/door-offline.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

/** What the door last said about the queued check-in it replayed. */
const lastAnswer = (world: TicketsWorld) =>
  requiredWorldValue(world.doorAnswer, "the door's answer");

When(
  "the organiser opens the {word} door",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    await openAdminPage(
      this,
      recordPath("listing", listingIdNamed(this, listing), "scanner"),
    );
  },
);

When(
  "the door sends {word}'s queued check-in at the {word} door",
  function (this: TicketsWorld, guest: string, listing: string): Promise<void> {
    return replayQueuedCheckIn(this, listing, guest);
  },
);

Then(
  "the {word} door's saved list holds {word}'s ticket as a digest only",
  async function (
    this: TicketsWorld,
    listing: string,
    guest: string,
  ): Promise<void> {
    const saved = await savedListAtDoor(this, listing);
    // The list is digests and nothing else: no ticket code, and no guest
    // detail a read of the device could hand over.
    expect(Object.keys(saved)).toEqual(["hashes"]);
    const hashes = saved.hashes as unknown[];
    expect(hashes).toContain(await sha256Hex(ticketOf(this, guest)));
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(saved)).not.toContain(ticketOf(this, guest));
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

Then(
  "the queued check-in said {word} was already checked in elsewhere",
  function (this: TicketsWorld, guest: string): void {
    expect(lastAnswer(this).status).toBe("already_checked_in");
    expect(lastAnswer(this).name).toBe(guest);
  },
);
