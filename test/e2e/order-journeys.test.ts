/**
 * More /order-flow journeys on the order-journey harness: a PAID mixed order
 * completed through the payment provider, two overlapping packages sharing a
 * listing, and an admin zeroing one path of an ordered booking — each walked
 * through the real gallery → booking page → submit journey and verified
 * against the stored rows.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  openEditorFromRoster,
  runOrderJourney,
} from "#test-utils/order-journey.ts";

describeWithEnv("e2e: order journeys", { db: true }, () => {
  test("a paid mixed order completes through the provider and settles in the ledger", async () => {
    // The Cabin sells at 400 through the bundle AND on its own row; the
    // Hamper is a plain paid listing. One checkout pays for all three paths.
    const { attendeeId, browser, catalog } = await runOrderJourney({
      catalog: {
        listings: [{ name: "Hamper", price: 1500 }],
        packages: [
          {
            members: [
              { name: "Cabin", price: 400 },
              { name: "Lodge", price: 600 },
            ],
            name: "Deluxe Kit",
          },
        ],
        parents: [],
      },
      form: (c) => ({
        [`package_quantity_${c.group("Deluxe Kit").id}`]: "1",
        [`quantity_${c.listing("Cabin").id}`]: "1",
        [`quantity_${c.listing("Hamper").id}`]: "2",
      }),
      paid: true,
      rows: (c) => [
        [c.listing("Cabin").id, c.group("Deluxe Kit").id, 0, 1, ""],
        [c.listing("Cabin").id, 0, 0, 1, ""],
        [c.listing("Lodge").id, c.group("Deluxe Kit").id, 0, 1, ""],
        [c.listing("Hamper").id, 0, 0, 2, ""],
      ],
      select: {
        listings: ["Cabin", "Hamper"],
        packages: ["Deluxe Kit"],
      },
    });

    // The money settled: the buyer owes nothing, and each listing recognised
    // its own paths' income — the Cabin's package unit AND its standalone
    // unit, 400 each.
    expect((await accountBalance(attendeeAccount(attendeeId))) + 0).toBe(0);
    expect(
      await accountBalance(revenueAccount(catalog.listing("Cabin").id)),
    ).toBe(800);
    expect(
      await accountBalance(revenueAccount(catalog.listing("Hamper").id)),
    ).toBe(3000);

    // The admin editor reads the paid order one line per path.
    await openEditorFromRoster(
      browser,
      catalog.listing("Cabin").id,
      "Journey Buyer",
    );
    expect(browser.containsText("via Deluxe Kit")).toBe(true);
    const cabin = catalog.listing("Cabin").id;
    const kit = catalog.group("Deluxe Kit").id;
    expect(attendeeLineIndex(browser.currentHtml, cabin, kit)).not.toBeNull();
    expect(attendeeLineIndex(browser.currentHtml, cabin, 0)).not.toBeNull();
  });

  test("two overlapping packages book the shared listing once per bundle", async () => {
    const { browser, catalog } = await runOrderJourney({
      catalog: {
        listings: [],
        packages: [
          {
            members: [{ name: "Tent", price: 0 }],
            name: "Camp Kit",
          },
          {
            members: [
              { name: "Tent", price: 0 },
              { name: "Rug", price: 0 },
            ],
            name: "Glamp Kit",
          },
        ],
        parents: [],
      },
      form: (c) => ({
        [`package_quantity_${c.group("Camp Kit").id}`]: "1",
        [`package_quantity_${c.group("Glamp Kit").id}`]: "1",
      }),
      rows: (c) => [
        [c.listing("Tent").id, c.group("Camp Kit").id, 0, 1, ""],
        [c.listing("Tent").id, c.group("Glamp Kit").id, 0, 1, ""],
        [c.listing("Rug").id, c.group("Glamp Kit").id, 0, 1, ""],
      ],
      select: { listings: [], packages: ["Camp Kit", "Glamp Kit"] },
    });

    // The editor labels the tent's two rows by their own bundles.
    await openEditorFromRoster(
      browser,
      catalog.listing("Tent").id,
      "Journey Buyer",
    );
    expect(browser.containsText("via Camp Kit")).toBe(true);
    expect(browser.containsText("via Glamp Kit")).toBe(true);
  });

  test("an admin can zero one path of an ordered booking (innards)", async () => {
    await runOrderJourney({
      catalog: {
        listings: [],
        packages: [
          {
            members: [{ name: "Drum", price: 0 }],
            name: "Duo Kit",
          },
        ],
        parents: [],
      },
      form: (c) => ({
        [`package_quantity_${c.group("Duo Kit").id}`]: "1",
        [`quantity_${c.listing("Drum").id}`]: "2",
      }),
      // The rows are verified AFTER the innards: the admin zeroed the
      // standalone path, so only the package path survives.
      rows: (c) => [[c.listing("Drum").id, c.group("Duo Kit").id, 0, 1, ""]],
      select: { listings: ["Drum"], packages: ["Duo Kit"] },
      through: async ({ browser, catalog }) => {
        const drum = catalog.listing("Drum").id;
        await openEditorFromRoster(browser, drum, "Journey Buyer");
        const standalone = attendeeLineIndex(browser.currentHtml, drum, 0)!;
        await browser.submitForm(
          { [`qty_${standalone}`]: "0" },
          "Save Attendee",
        );
        expect(browser.containsText("Updated Journey Buyer")).toBe(true);
      },
    });
  });
});
