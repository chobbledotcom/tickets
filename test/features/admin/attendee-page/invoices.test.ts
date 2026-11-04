/** The attendee page's invoice row, and the links that start an invoice. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createInvoice, nextInvoiceNumber } from "#db/invoices.ts";
import { type SettingsData, settings } from "#db/settings.ts";
import { canCreateInvoice } from "#routes/admin/attendee-invoice-link.ts";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { isReadOnly } from "#shared/env.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { bookAttendee, tabHtml } from "./helpers.ts";

const CREATED = "2026-11-04T09:00:00.000Z";

/** Store one invoice for the attendee, as a create would. */
const addInvoice = async (attendeeId: number): Promise<number> => {
  const { invoice } = await createInvoice({
    attendeeId,
    bodyHtml: "<h1>Invoice</h1>",
    created: CREATED,
    id: await nextInvoiceNumber(),
  });
  return invoice.id;
};

/** Set the Invoices switch for the case under test. */
const setInvoicesSwitch = (enabled: boolean): void => {
  const enabled_features: SettingsData["enabled_features"] =
    serializeEnabledFeatures(
      setFeatureEnabled(parseEnabledFeatures(""), "invoices", enabled),
    );
  settings.setForTest({ enabled_features });
};

/** Where an invoice for this attendee is started. */
const createLink = (attendeeId: number): string =>
  `/admin/invoices/new?attendee=${attendeeId}`;

describeWithEnv("the attendee page's invoices", { db: true }, () => {
  test("shows no invoice row for an attendee with none", async () => {
    const html = await tabHtml(await bookAttendee(), "");
    assert(!html.includes("/admin/invoices/"));
  });

  test("shows the invoice row with its status and date once one exists", async () => {
    setInvoicesSwitch(true);
    const id = await bookAttendee();
    const invoiceId = await addInvoice(id);

    const html = await tabHtml(id, "");

    assertStringIncludes(html, `<a href="/admin/invoices/${invoiceId}">`);
    assertStringIncludes(html, "New");
    assertStringIncludes(html, "Wednesday 4 November 2026");
  });

  /** Every fact the create links read, both ways. The two tabs offer the link
   *  under one rule, so each case asks both. */
  const linkCases = [
    {
      attendeeBalance: 1500,
      name: "with the Invoices switch off",
      newInvoice: false,
      offered: false,
      switchOn: false,
    },
    {
      attendeeBalance: 0,
      name: "owing nothing",
      newInvoice: false,
      offered: false,
      switchOn: true,
    },
    {
      attendeeBalance: 1500,
      name: "with a new invoice already covering it",
      newInvoice: true,
      offered: false,
      switchOn: true,
    },
    {
      attendeeBalance: 1500,
      name: "owing money that no new invoice covers",
      newInvoice: false,
      offered: true,
      switchOn: true,
    },
  ];

  for (const option of linkCases) {
    test(`offers Create invoice on both tabs: ${option.name}`, async () => {
      setInvoicesSwitch(option.switchOn);
      const attendeeId =
        option.attendeeBalance === 0
          ? await bookAttendee()
          : (await createReservedAttendee(option.attendeeBalance)).attendeeId;
      if (option.newInvoice) await addInvoice(attendeeId);
      const link = createLink(attendeeId);

      expect((await tabHtml(attendeeId, "actions")).includes(link)).toBe(
        option.offered,
      );
      expect((await tabHtml(attendeeId, "ledger")).includes(link)).toBe(
        option.offered,
      );
    });
  }

  test("offers the link on the Actions tab with a booking that still owes", async () => {
    setInvoicesSwitch(true);
    const { attendeeId } = await createReservedAttendee(1500);

    const html = await tabHtml(attendeeId, "actions");

    assertStringIncludes(html, `href="${createLink(attendeeId)}"`);
    assertStringIncludes(html, "Create invoice");
  });

  test("offers no invoice to an attendee with no booking balance", () => {
    setInvoicesSwitch(true);

    expect(canCreateInvoice({ balance: null, hasNewInvoice: false })).toBe(
      false,
    );
  });

  test("offers no Create invoice while the site is read-only", async () => {
    setInvoicesSwitch(true);
    const { attendeeId } = await createReservedAttendee(1500);
    const link = createLink(attendeeId);

    const env = withEnv({ UPDATE_IN_PROGRESS: "1" });
    try {
      assert(isReadOnly(), "the site is not read-only");
      expect((await tabHtml(attendeeId, "actions")).includes(link)).toBe(false);
      expect((await tabHtml(attendeeId, "ledger")).includes(link)).toBe(false);
    } finally {
      env.dispose();
    }
  });
});
