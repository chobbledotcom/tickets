/** The scan rule both doors share: what one scan admits, and what it says
 * when it admits nothing. Exercised directly, so the one-listing-at-a-time
 * walk, the group's check-every-listing box, the ID hold, and force all have
 * exact tests of their own beside the route suites. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decideScan, rowsByListing } from "#routes/admin/scan-decision.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

/** One booking row on a named listing, ticked or refunded as asked. */
const rowOn = (
  listingId: number,
  name: string,
  state: {
    admitted?: number;
    checked?: boolean;
    nonTransferable?: boolean;
    quantity?: number;
    purchaseOnly?: boolean;
    refunded?: boolean;
  } = {},
): TokenEntry =>
  testTokenEntry({
    attendee: {
      checked_in: state.admitted ?? (state.checked ? 1 : 0),
      id: 7,
      quantity: state.quantity ?? 1,
      refunded: state.refunded ?? false,
    },
    listing: {
      id: listingId,
      name,
      non_transferable: state.nonTransferable ?? false,
      purchase_only: state.purchaseOnly ?? false,
    },
  });

const standard = (state = {}) => rowOn(1, "Standard", state);
const society = (state = {}) => rowOn(2, "Society", state);
const guest = (state = {}) => rowOn(3, "Guest", state);

/** This door's listings. */
const doorScope = new Set([1, 2, 3]);

/** One scan at this door, with the controls a camera or manual pick sends. */
const scanAt = (
  entries: readonly TokenEntry[],
  controls: {
    checkEvery?: boolean;
    count?: number;
    force?: boolean;
    idVerified?: boolean;
  } = {},
) =>
  decideScan(
    {
      entries,
      force: controls.force ?? false,
      scope: doorScope,
    },
    controls.checkEvery ?? false,
    controls.idVerified ?? false,
    controls.count,
  );

/** The expected admit when every covered row owes exactly one ticket. */
const admitsOne = (rows: readonly TokenEntry[], remaining: number) => ({
  kind: "admit",
  remaining,
  rows: [...rows],
  units: rowsByListing(rows).map((unit) => ({ rows: unit, tickets: 1 })),
});

describe("decideScan", () => {
  test("admits the first listing with an unchecked row and counts what remains", () => {
    expect(scanAt([standard(), society(), guest()])).toEqual(
      admitsOne([standard()], 2),
    );
  });

  test("a repeat scan walks to the next listing with an unchecked row", () => {
    expect(scanAt([standard({ checked: true }), society(), guest()])).toEqual(
      admitsOne([society()], 1),
    );
  });

  test("every listing checked in answers already_checked_in with its live rows", () => {
    expect(
      scanAt([standard({ checked: true }), society({ checked: true })]),
    ).toEqual({
      kind: "already_checked_in",
      live: [standard({ checked: true }), society({ checked: true })],
    });
  });

  test("the check-every-listing box admits every listing with an unchecked row", () => {
    expect(
      scanAt([standard(), society({ checked: true }), guest()], {
        checkEvery: true,
      }),
    ).toEqual(admitsOne([standard(), guest()], 0));
  });

  test("a part-checked-in ticket under the box admits only what remains", () => {
    expect(
      scanAt([standard({ checked: true }), society()], { checkEvery: true }),
    ).toEqual(admitsOne([society()], 0));
  });

  test("refunded rows are skipped while any live row remains", () => {
    expect(scanAt([standard({ refunded: true }), society()])).toEqual(
      admitsOne([society()], 0),
    );
  });

  test("every row refunded answers refunded", () => {
    expect(
      scanAt([standard({ refunded: true }), society({ refunded: true })]),
    ).toEqual({ kind: "refunded" });
  });

  test("a non-transferable listing holds the ticket until the ID is confirmed", () => {
    const held = scanAt([standard({ nonTransferable: true })]);
    expect(held).toEqual({
      kind: "verify_id",
      rows: [standard({ nonTransferable: true })],
    });
    const admitted = scanAt([standard({ nonTransferable: true })], {
      idVerified: true,
    });
    expect(admitted).toEqual(
      admitsOne([standard({ nonTransferable: true })], 0),
    );
  });

  test("a non-transferable listing already checked in answers already", () => {
    expect(
      scanAt([standard({ checked: true, nonTransferable: true }), society()]),
    ).toEqual(admitsOne([society()], 0));
  });

  test("no row in scope answers wrong_listing", () => {
    expect(scanAt([rowOn(9, "Quiz")])).toEqual({ kind: "wrong_listing" });
  });

  test("force widens a ticket that matches nowhere in scope", () => {
    const quiz = rowOn(9, "Quiz");
    expect(scanAt([quiz], { force: true })).toEqual(admitsOne([quiz], 0));
  });

  test("force widened onto several outside listings stays one at a time", () => {
    // The group's own checkbox must not widen a forced override with it: the
    // door the organiser stands at decides one listing at a time.
    const results = scanAt([rowOn(9, "Quiz"), rowOn(10, "Talk")], {
      checkEvery: true,
      force: true,
    });
    expect(results).toEqual(admitsOne([rowOn(9, "Quiz")], 1));
  });

  test("force never narrows a ticket that matches in scope", () => {
    expect(scanAt([standard(), rowOn(9, "Quiz")], { force: true })).toEqual(
      admitsOne([standard()], 0),
    );
  });

  test("an empty ticket answers wrong_listing unforced and not_found forced", () => {
    expect(scanAt([])).toEqual({ kind: "wrong_listing" });
    expect(scanAt([], { force: true })).toEqual({ kind: "not_found" });
  });

  test("a line owing more than one ticket asks how many to admit", () => {
    const row = standard({ quantity: 4 });
    expect(scanAt([row])).toEqual({
      kind: "select_quantity",
      max: 4,
      rows: [row],
    });
  });

  test("the door's pick admits that many tickets on the line", () => {
    const row = standard({ quantity: 4 });
    expect(scanAt([row], { count: 2 })).toEqual({
      kind: "admit",
      remaining: 2,
      rows: [row],
      units: [{ rows: [row], tickets: 2 }],
    });
  });

  test("the pick cannot exceed what the line still owes", () => {
    const row = standard({ admitted: 2, quantity: 3 });
    expect(scanAt([row], { count: 5 })).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [row],
      units: [{ rows: [row], tickets: 1 }],
    });
  });

  test("under the box the pick applies to every listing, capped per listing", () => {
    const four = standard({ quantity: 4 });
    const two = society({ quantity: 2 });
    expect(scanAt([four, two], { checkEvery: true, count: 3 })).toEqual({
      kind: "admit",
      remaining: 1,
      rows: [four, two],
      units: [
        { rows: [four], tickets: 3 },
        { rows: [two], tickets: 2 },
      ],
    });
  });

  test("a line owing exactly one admits straight in, pick or no pick", () => {
    expect(scanAt([standard()], { count: 1 })).toEqual(
      admitsOne([standard()], 0),
    );
  });

  test("a no-check-in listing's row never admits at its own door", () => {
    const merch = rowOn(4, "Merch Stand", { purchaseOnly: true });
    const ownDoor = new Set([4]);
    for (const force of [false, true]) {
      expect(
        decideScan({ entries: [merch], force, scope: ownDoor }, false, false),
      ).toEqual({ kind: "wrong_listing" });
    }
  });

  test("a no-check-in row admits nothing even beside a checkable one", () => {
    const merch = rowOn(4, "Merch Stand", { purchaseOnly: true });
    expect(scanAt([standard(), merch])).toEqual(admitsOne([standard()], 0));
  });

  test("force never widens onto a no-check-in row", () => {
    const merch = rowOn(4, "Merch Stand", { purchaseOnly: true });
    const distant = rowOn(9, "Far Away");
    // The ticket matches nowhere in scope, so force widens — but only onto
    // door-safe listings.
    expect(scanAt([merch, distant], { force: true })).toEqual(
      admitsOne([distant], 0),
    );
  });
});

describe("rowsByListing", () => {
  test("groups a ticket's rows by listing, keeping booking order", () => {
    const rows = [standard(), society(), standard({ checked: true }), guest()];
    expect(rowsByListing(rows)).toEqual([
      [standard(), standard({ checked: true })],
      [society()],
      [guest()],
    ]);
  });
});
