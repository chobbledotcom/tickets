import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type RowAccountType,
  RowAccountTypeSchema,
} from "#accounting/accounts.ts";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  type AdminDestinationId,
  adminRecordPath,
} from "#shared/admin-surface.ts";
import { account } from "#shared/ledger/account.ts";
import {
  attendeeLinkRefs,
  names,
  renderLedger,
  transfer,
} from "#test/ui/templates/admin/ledger/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

/** The admin page each row-backed money account opens, keyed by the picklist
 *  the account types come from, so a new type must decide its page here. */
const ROW_ACCOUNT_PAGE: Record<RowAccountType, AdminDestinationId> = {
  attendee: "attendee",
  cost: "listing",
  modifier: "modifier",
  revenue: "listing",
};

/** One named row per account type, each with a name of its own so a rendered
 *  link is identified by the record it shows. */
const ROW_ACCOUNT_ROWS: Record<
  RowAccountType,
  { name: string; rowId: number }
> = {
  attendee: { name: "Ada Lovelace", rowId: 7 },
  cost: { name: "Boiler Hire", rowId: 4 },
  modifier: { name: "Early bird", rowId: 5 },
  revenue: { name: "Summer Concert", rowId: 3 },
};

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
    assertStringIncludes(html, "Tax");
    assertStringIncludes(html, "Corrections");
    assert(!html.includes("/admin/ledger/external/"));
    assert(!html.includes("/admin/ledger/fee_income/"));
    assert(!html.includes("/admin/ledger/tax/"));
    assert(!html.includes("/admin/ledger/writeoff/"));
  });

  test("links each row-backed account to the record page the routes declare", () => {
    const { attendee, cost, modifier, revenue } = ROW_ACCOUNT_ROWS;
    const refs = names({
      attendees: attendeeLinkRefs([[attendee.rowId, attendee.name]]),
      listings: new Map([
        [revenue.rowId, revenue.name],
        [cost.rowId, cost.name],
      ]),
      modifiers: new Map([[modifier.rowId, modifier.name]]),
    });
    const html = renderLedger(
      RowAccountTypeSchema.options.map((type) =>
        transfer({
          destination: account("external", "world"),
          source: account(type, ROW_ACCOUNT_ROWS[type].rowId),
        }),
      ),
      refs,
      "dual",
    );
    for (const type of RowAccountTypeSchema.options) {
      const { name, rowId } = ROW_ACCOUNT_ROWS[type];
      // The target is the record's own declared page, not a URL this test
      // copies from the template.
      assertStringIncludes(
        html,
        `<a href="${adminRecordPath(ROW_ACCOUNT_PAGE[type], rowId)}">${name}</a>`,
      );
    }
    // No account leg points back at the ledger or at a filtered ledger.
    assert(!html.includes("/admin/ledger/attendee/"));
    assert(!html.includes("/admin/ledger/modifier/"));
    assert(!html.includes("/admin/ledger?listing="));
  });

  test("links a service event account to the service event page", () => {
    const html = renderLedger(
      [
        transfer({
          destination: account("revenue", 3),
          source: account("attendee", 4),
        }),
      ],
      names({
        attendees: attendeeLinkRefs([[4, "Boiler Service", SERVICING_KIND]]),
        listings: new Map([[3, "Summer Concert"]]),
      }),
      "dual",
    );
    // A service event's own page is the route the surface declares as
    // `servicingEdit`.
    assertStringIncludes(
      html,
      `<a href="${adminRecordPath("servicingEdit", 4)}">Boiler Service</a>`,
    );
    assert(!html.includes("/admin/attendees/4"));
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
    assert(!html.includes("/admin/attendees/42"));
    assert(!html.includes("/admin/modifiers/8"));
  });
});
