import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import {
  names,
  renderLedger,
  transfer,
} from "#test/ui/templates/admin/ledger/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("money account labels", () => {
  beforeAll(setupAdminPageTest);

  test("names singleton accounts without linking them", () => {
    const html = renderLedger(
      [
        transfer({ source: account("external", "world") }),
        transfer({ source: account("fee_income", "booking") }),
        transfer({ source: account("tax", "vat") }),
        transfer({ source: account("writeoff", "x") }),
      ],
      names(),
      "dual",
    );
    assertStringIncludes(html, "Card / bank");
    assertStringIncludes(html, "Booking fees");
    assertStringIncludes(html, "VAT");
    assertStringIncludes(html, "Corrections");
    assert(!html.includes("/admin/ledger/external/"));
    assert(!html.includes("/admin/ledger/fee_income/"));
    assert(!html.includes("/admin/ledger/tax/"));
    assert(!html.includes("/admin/ledger/writeoff/"));
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
    assertStringIncludes(
      html,
      '<a href="/admin/ledger/attendee/7">Ada Lovelace</a>',
    );
    assertStringIncludes(
      html,
      '<a href="/admin/ledger?listing=3">Summer Concert</a>',
    );
    assertStringIncludes(
      html,
      '<a href="/admin/ledger/modifier/5">Early bird</a>',
    );
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
    assertStringIncludes(html, "Attendee #42");
    assertStringIncludes(html, "Listing #9");
    assertStringIncludes(html, "Modifier #8");
    assert(!html.includes("/admin/ledger/attendee/42"));
    assert(!html.includes("/admin/ledger/modifier/8"));
  });
});
