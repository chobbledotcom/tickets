import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";

import {
  names,
  renderLedger,
  setUpLedgerPageCrypto,
  transfer,
} from "./helpers.ts";

describe("money account labels", () => {
  beforeAll(setUpLedgerPageCrypto);

  test("names singleton accounts without linking them", () => {
    const html = renderLedger(
      [
        transfer({ source: account("external", "world") }),
        transfer({ source: account("fee_income", "booking") }),
        transfer({ source: account("writeoff", "x") }),
      ],
      names(),
      "dual",
    );
    expect(html).toContain("Card / bank");
    expect(html).toContain("Booking fees");
    expect(html).toContain("Corrections");
    expect(html).not.toContain("/admin/ledger/external/");
    expect(html).not.toContain("/admin/ledger/fee_income/");
    expect(html).not.toContain("/admin/ledger/writeoff/");
  });

  test("links each existing row-backed account by name", () => {
    const refs = names({
      attendees: new Map([[7, "Ada Lovelace"]]),
      listings: new Map([[3, "Summer Concert"]]),
      modifiers: new Map([[5, "Early bird"]]),
    });
    const html = renderLedger(
      [
        transfer({
          destination: account("revenue", 3),
          source: account("attendee", 7),
        }),
        transfer({
          destination: account("cost", 3),
          source: account("modifier", 5),
        }),
      ],
      refs,
      "dual",
    );
    expect(html).toContain(
      '<a href="/admin/ledger/attendee/7">Ada Lovelace</a>',
    );
    expect(html).toContain(
      '<a href="/admin/ledger?listing=3">Summer Concert</a>',
    );
    expect(html).toContain('<a href="/admin/ledger/modifier/5">Early bird</a>');
  });

  test("throws when an account type has no presentation", () => {
    expect(() =>
      renderLedger(
        [transfer({ source: account("psp", "stripe") })],
        names(),
        "dual",
      ),
    ).toThrow("Unknown money account type: psp");
  });

  test("shows deleted row-backed accounts as plain fallback text", () => {
    const html = renderLedger(
      [
        transfer({
          destination: account("revenue", 9),
          source: account("attendee", 42),
        }),
        transfer({
          destination: account("cost", 9),
          source: account("modifier", 8),
        }),
      ],
      names(),
      "dual",
    );
    expect(html).toContain("Attendee #42");
    expect(html).toContain("Listing #9");
    expect(html).toContain("Modifier #8");
    expect(html).not.toContain("/admin/ledger/attendee/42");
    expect(html).not.toContain("/admin/ledger/modifier/8");
  });
});
