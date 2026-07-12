import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#shared/accounting/manual-entries.ts";
import { account } from "#shared/ledger/account.ts";
import {
  adminLedgerEntryAddPage,
  type LedgerEntryAddOption,
} from "#templates/admin/ledger/entry-pages.tsx";

import { names, SESSION } from "./helpers.ts";

describe("adminLedgerEntryAddPage", () => {
  test("preselects the posted entry type when redisplaying the add form", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    const options: LedgerEntryAddOption[] = [
      {
        hint: "Money received",
        hintKey: "admin.ledger.add.option.attendee_payment.hint",
        label: "Payment",
        labelKey: "admin.ledger.add.option.attendee_payment.label",
        type: MANUAL_ATTENDEE_PAYMENT,
      },
      {
        hint: "New charge",
        hintKey: "admin.ledger.add.option.attendee_charge.hint",
        label: "Charge",
        labelKey: "admin.ledger.add.option.attendee_charge.label",
        type: MANUAL_ATTENDEE_CHARGE,
      },
      {
        hint: "Waive charge",
        hintKey: "admin.ledger.add.option.attendee_writeoff.hint",
        label: "Waived amount",
        labelKey: "admin.ledger.add.option.attendee_writeoff.label",
        type: MANUAL_ATTENDEE_WRITEOFF,
      },
    ];
    const html = adminLedgerEntryAddPage({
      account: account("attendee", 7),
      names: refs,
      options,
      returnUrl: "/admin/attendees/7",
      session: SESSION,
      values: {
        amount: "5.00",
        entryType: MANUAL_ATTENDEE_CHARGE,
        occurredAt: "2026-06-22T09:30",
      },
    });
    expect(html).toContain(
      '<option selected value="manual_attendee_charge">Charge</option>',
    );
    expect(html).toContain(
      '<option value="manual_attendee_payment">Payment</option>',
    );
  });
});
