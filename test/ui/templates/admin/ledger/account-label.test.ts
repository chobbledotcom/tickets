import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { resolveAccountLabel } from "#templates/admin/ledger.tsx";

import { names } from "./helpers.ts";

describe("resolveAccountLabel", () => {
  test("names singleton accounts from i18n with no link", () => {
    expect(resolveAccountLabel(account("external", "world"), names())).toEqual({
      text: "Card / bank",
    });
    expect(
      resolveAccountLabel(account("fee_income", "booking"), names()),
    ).toEqual({ text: "Booking fees" });
  });

  test("labels every correction account the same way regardless of id", () => {
    // The chart of accounts treats writeoff as one logical contra account, so
    // the label is matched on the type alone — a stray id must not change it.
    expect(resolveAccountLabel(account("writeoff", "x"), names())).toEqual({
      text: "Corrections",
    });
  });

  test("links a row-backed account to its entity by name", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    expect(resolveAccountLabel(account("attendee", 7), refs)).toEqual({
      href: "/admin/ledger/attendee/7",
      text: "Ada Lovelace",
    });
  });

  test("links listing-backed revenue and cost legs to the listing", () => {
    const refs = names({
      listings: new Map([[3, "Summer Concert"]]),
    });
    expect(resolveAccountLabel(account("revenue", 3), refs)).toEqual({
      href: "/admin/ledger?listing=3",
      text: "Summer Concert",
    });
    expect(resolveAccountLabel(account("cost", 3), refs)).toEqual({
      href: "/admin/ledger?listing=3",
      text: "Summer Concert",
    });
  });

  test("links modifier legs to their edit page", () => {
    const refs = names({
      modifiers: new Map([[5, "Early bird"]]),
    });
    expect(resolveAccountLabel(account("modifier", 5), refs)).toEqual({
      href: "/admin/ledger/modifier/5",
      text: "Early bird",
    });
  });

  test("throws when an account type has no presentation", () => {
    expect(() =>
      resolveAccountLabel(account("psp", "stripe"), names()),
    ).toThrow("Unknown money account type: psp");
  });

  test("falls back to '<Entity> #<id>' with no link when the id is absent", () => {
    // A deleted entity keeps its ledger rows; its id outlives the name, so the
    // leg degrades to plain text rather than linking to a missing page.
    expect(resolveAccountLabel(account("attendee", 42), names())).toEqual({
      text: "Attendee #42",
    });
    expect(resolveAccountLabel(account("revenue", 9), names())).toEqual({
      text: "Listing #9",
    });
    expect(resolveAccountLabel(account("cost", 9), names())).toEqual({
      text: "Listing #9",
    });
    expect(resolveAccountLabel(account("modifier", 8), names())).toEqual({
      text: "Modifier #8",
    });
  });
});
