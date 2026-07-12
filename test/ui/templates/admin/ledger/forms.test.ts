import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#shared/accounting/manual-entries.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  defineLedgerEntryAddForm,
  type LedgerEntryAddOption,
  ledgerEntryForm,
} from "#templates/admin/ledger/entry-form.ts";
import { testWithSetting } from "#test-utils/settings.ts";

describe("ledger entry forms", () => {
  test("preselects the posted entry type when redisplaying the add form", () => {
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
    const html = defineLedgerEntryAddForm(options).renderFields({
      amount: "5.00",
      entry_type: MANUAL_ATTENDEE_CHARGE,
      occurred_at: "2026-06-22T09:30",
    });
    expect(html).toContain(
      '<option value="manual_attendee_charge" selected>Charge</option>',
    );
    expect(html).toContain(
      '<option value="manual_attendee_payment">Payment</option>',
    );
  });

  test("uses the dynamic option schema to reject a type from another account", () => {
    const options: LedgerEntryAddOption[] = [
      {
        hint: "Money received",
        hintKey: "admin.ledger.add.option.attendee_payment.hint",
        label: "Payment",
        labelKey: "admin.ledger.add.option.attendee_payment.label",
        type: MANUAL_ATTENDEE_PAYMENT,
      },
    ];
    const result = defineLedgerEntryAddForm(options).validate(
      new FormParams({
        amount: "5.00",
        entry_type: MANUAL_ATTENDEE_CHARGE,
        occurred_at: "2026-06-22T09:30",
      }),
    );
    expect(result).toEqual({
      error: "Choose what happened.",
      valid: false,
    });
  });

  testWithSetting(
    "parses amount and local date from the shared edit schema",
    { timezone: "UTC" },
    () => {
      const result = ledgerEntryForm.validate(
        new FormParams({
          amount: "12.34",
          occurred_at: "2026-06-22T09:30",
        }),
      );
      expect(result).toEqual({
        valid: true,
        values: {
          amount: 1234,
          occurred_at: "2026-06-22T09:30:00.000Z",
        },
      });
    },
  );

  test("returns catalog errors for invalid amount and date values", () => {
    expect(
      ledgerEntryForm.validate(
        new FormParams({
          amount: "12.345",
          occurred_at: "2026-06-22T09:30",
        }),
      ),
    ).toEqual({ error: "Enter a valid amount.", valid: false });
    expect(
      ledgerEntryForm.validate(
        new FormParams({ amount: "12.34", occurred_at: "not-a-date" }),
      ),
    ).toEqual({ error: "Enter a valid date and time.", valid: false });
  });
});
