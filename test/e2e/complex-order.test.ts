/**
 * One VERY mixed public order, validated end-to-end on the admin side.
 *
 * The buyer walks the real journey — /order gallery selection → cart booking
 * page → reservation — putting every listing shape into ONE order:
 *
 *   - a package ("Mega Kit": 2× Tent + 1× Stove per unit),
 *   - the Tent AGAIN standalone (the same listing through two paths),
 *   - a parent ("Marquee") whose sole bookable-alone child ("Generator")
 *     auto-folds under it, PLUS the Generator standalone by its own card,
 *   - a plain listing ("T-Shirt"),
 *   - a daily listing ("Campervan") on a chosen date.
 *
 * The admin then sees the order exactly as stored: one editor line per path,
 * labelled by path, with the stored rows to match.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  lineCountFor,
  lineQty,
  openEditorFromRoster,
  runOrderJourney,
} from "#test-utils/order-journey.ts";

describeWithEnv("e2e: one complex mixed order", { db: true }, () => {
  test("package + overlap + parent/child + plain + daily book as one order the admin can read", async () => {
    const date = addDays(todayInTz(settings.timezone), 3);
    const { browser, catalog } = await runOrderJourney({
      catalog: {
        listings: [{ name: "T-Shirt" }, { daily: true, name: "Campervan" }],
        packages: [
          {
            members: [
              { name: "Tent", price: 0, quantity: 2 },
              { name: "Stove", price: 0 },
            ],
            name: "Mega Kit",
          },
        ],
        parents: [{ childName: "Generator", name: "Marquee" }],
      },
      form: (c) => ({
        date,
        name: "Complex Buyer",
        [`package_quantity_${c.group("Mega Kit").id}`]: "1",
        [`quantity_${c.listing("Campervan").id}`]: "1",
        [`quantity_${c.listing("Generator").id}`]: "1",
        [`quantity_${c.listing("Marquee").id}`]: "1",
        [`quantity_${c.listing("Tent").id}`]: "1",
        [`quantity_${c.listing("T-Shirt").id}`]: "3",
      }),
      // One row per path: the tent through the package (2 a unit) AND its own
      // row, the generator folded under the marquee AND its own row, and the
      // campervan on the chosen date.
      rows: (c) => [
        [c.listing("Tent").id, c.group("Mega Kit").id, 0, 2, ""],
        [c.listing("Tent").id, 0, 0, 1, ""],
        [c.listing("Stove").id, c.group("Mega Kit").id, 0, 1, ""],
        [c.listing("Marquee").id, 0, 0, 1, ""],
        [c.listing("Generator").id, 0, c.listing("Marquee").id, 1, ""],
        [c.listing("Generator").id, 0, 0, 1, ""],
        [c.listing("T-Shirt").id, 0, 0, 3, ""],
        [c.listing("Campervan").id, 0, 0, 1, date],
      ],
      select: {
        date,
        listings: ["Tent", "Marquee", "Generator", "T-Shirt", "Campervan"],
        packages: ["Mega Kit"],
      },
    });

    // Admin: from the Tent roster to the buyer's editor — one line per path,
    // each labelled by its path, quantities as booked.
    const tent = catalog.listing("Tent");
    await openEditorFromRoster(browser, tent.id, "Complex Buyer");
    const editor = browser.currentHtml;
    const kitId = catalog.group("Mega Kit").id;
    const tentViaKit = attendeeLineIndex(editor, tent.id, kitId);
    const tentOwnRow = attendeeLineIndex(editor, tent.id, 0);
    expect(tentViaKit).not.toBeNull();
    expect(tentOwnRow).not.toBeNull();
    expect(tentViaKit).not.toBe(tentOwnRow);
    expect(lineQty(editor, tentViaKit!)).toBe("2");
    expect(lineQty(editor, tentOwnRow!)).toBe("1");
    expect(
      lineQty(
        editor,
        attendeeLineIndex(editor, catalog.listing("Stove").id, kitId)!,
      ),
    ).toBe("1");
    expect(
      lineQty(
        editor,
        attendeeLineIndex(editor, catalog.listing("T-Shirt").id, 0)!,
      ),
    ).toBe("3");
    expect(browser.containsText("via Mega Kit")).toBe(true);
    expect(browser.containsText("add-on under Marquee")).toBe(true);
    // The generator books twice — folded under the marquee and standalone.
    expect(lineCountFor(editor, catalog.listing("Generator").id)).toBe(2);
    // The shared date range carries the campervan's booked date.
    expect(editor).toContain(`name="start_date"`);
    expect(editor).toContain(`value="${date}"`);

    // The rosters agree: every listing in the order lists the buyer.
    for (const name of ["Stove", "Campervan"]) {
      await browser.visit(
        `/admin/listing/${catalog.listing(name).id}/attendees`,
      );
      expect(browser.containsText("Complex Buyer")).toBe(true);
    }
  });
});
