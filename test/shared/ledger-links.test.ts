/** The ledger's shared entry hrefs: the admin tables link with them and the
 * POST handlers redirect with them, so both spellings must stay one. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ledgerEntryAddHref,
  ledgerEntryEditHref,
  listingLedgerHref,
} from "#shared/ledger-links.ts";

describe("ledger links", () => {
  test("the edit form href carries the transfer id and encoded return URL", () => {
    // The ledger table cell shape (was inline in the ledger template).
    expect(ledgerEntryEditHref(42, "/admin/ledger/statement/7")).toBe(
      "/admin/ledger/entries/42/edit?return_url=%2Fadmin%2Fledger%2Fstatement%2F7",
    );
  });

  test("the add form href names the account's type and id", () => {
    // The entry POST redirect shape (was inline in the entries route).
    expect(
      ledgerEntryAddHref({ id: "9", type: "revenue" }, "/admin/ledger"),
    ).toBe("/admin/ledger/revenue/9/add?return_url=%2Fadmin%2Fledger");
  });

  test("the full-ledger href scopes to one listing", () => {
    expect(listingLedgerHref(5)).toBe("/admin/ledger?listing=5");
  });
});
