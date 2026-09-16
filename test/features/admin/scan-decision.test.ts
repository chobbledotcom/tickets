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
    checked?: boolean;
    nonTransferable?: boolean;
    refunded?: boolean;
  } = {},
): TokenEntry =>
  testTokenEntry({
    attendee: {
      checked_in: state.checked ?? false,
      id: 7,
      quantity: 1,
      refunded: state.refunded ?? false,
    },
    listing: {
      id: listingId,
      name,
      non_transferable: state.nonTransferable ?? false,
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
    force?: boolean;
    idVerified?: boolean;
  } = {},
) =>
  decideScan(
    entries,
    doorScope,
    controls.force ?? false,
    controls.checkEvery ?? false,
    controls.idVerified ?? false,
  );

describe("decideScan", () => {
  test("admits the first listing with an unchecked row and counts what remains", () => {
    expect(scanAt([standard(), society(), guest()])).toEqual({
      kind: "admit",
      remaining: 2,
      rows: [standard()],
    });
  });

  test("a repeat scan walks to the next listing with an unchecked row", () => {
    expect(scanAt([standard({ checked: true }), society(), guest()])).toEqual({
      kind: "admit",
      remaining: 1,
      rows: [society()],
    });
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
    ).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [standard(), guest()],
    });
  });

  test("a part-checked-in ticket under the box admits only what remains", () => {
    expect(
      scanAt([standard({ checked: true }), society()], { checkEvery: true }),
    ).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [society()],
    });
  });

  test("refunded rows are skipped while any live row remains", () => {
    expect(scanAt([standard({ refunded: true }), society()])).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [society()],
    });
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
    expect(admitted).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [standard({ nonTransferable: true })],
    });
  });

  test("a non-transferable listing already checked in answers already", () => {
    expect(
      scanAt([standard({ checked: true, nonTransferable: true }), society()]),
    ).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [society()],
    });
  });

  test("no row in scope answers wrong_listing", () => {
    expect(scanAt([rowOn(9, "Quiz")])).toEqual({ kind: "wrong_listing" });
  });

  test("force widens a ticket that matches nowhere in scope", () => {
    const quiz = rowOn(9, "Quiz");
    expect(scanAt([quiz], { force: true })).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [quiz],
    });
  });

  test("force never narrows a ticket that matches in scope", () => {
    expect(scanAt([standard(), rowOn(9, "Quiz")], { force: true })).toEqual({
      kind: "admit",
      remaining: 0,
      rows: [standard()],
    });
  });

  test("an empty ticket answers wrong_listing unforced and not_found forced", () => {
    expect(scanAt([])).toEqual({ kind: "wrong_listing" });
    expect(scanAt([], { force: true })).toEqual({ kind: "not_found" });
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
