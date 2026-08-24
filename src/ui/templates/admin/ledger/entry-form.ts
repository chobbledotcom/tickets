import type { ManualLedgerEntryOption } from "#accounting/manual-entries.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { defineForm, type FormDefinition } from "#shared/forms/definition.ts";
import { requireChoiceOptions } from "#shared/forms/field.ts";
import { localToUtc } from "#shared/timezone.ts";
import { parsePositiveMinorUnits } from "#shared/validation/money.ts";

export type LedgerEntryAddOption = ManualLedgerEntryOption & {
  hint: string;
  label: string;
};

const parseOccurredAt = (value: string): string | null => {
  try {
    return localToUtc(value, settings.timezone);
  } catch {
    return null;
  }
};

const LEDGER_ENTRY_FIELDS = [
  {
    invalidMessage: t("admin.ledger.form.amount_invalid"),
    label: t("admin.ledger.form.amount"),
    min: 0,
    name: "amount",
    parse: parsePositiveMinorUnits,
    required: true,
    requiredMessage: t("admin.ledger.form.amount_required"),
    type: "money",
  },
  {
    invalidMessage: t("admin.ledger.form.occurred_at_invalid"),
    label: t("admin.ledger.form.occurred_at"),
    name: "occurred_at",
    parse: parseOccurredAt,
    required: true,
    requiredMessage: t("admin.ledger.form.occurred_at_required"),
    type: "datetime-local",
  },
] as const;

export const ledgerEntryForm = defineForm({
  fields: LEDGER_ENTRY_FIELDS,
});

const ledgerEntryAddFields = (options: LedgerEntryAddOption[]) =>
  [
    {
      invalidMessage: t("admin.ledger.form.entry_type_invalid"),
      label: t("admin.ledger.add.type"),
      name: "entry_type",
      options: requireChoiceOptions(
        t("admin.ledger.add.type"),
        options.map((option) => ({
          hint: option.hint,
          label: option.label,
          value: option.type,
        })),
      ),
      required: true,
      requiredMessage: t("admin.ledger.form.entry_type_required"),
      type: "select",
    },
    ...LEDGER_ENTRY_FIELDS,
  ] as const;

type LedgerEntryAddFields = ReturnType<typeof ledgerEntryAddFields>;

export const defineLedgerEntryAddForm = (
  options: LedgerEntryAddOption[],
): FormDefinition<LedgerEntryAddFields> =>
  defineForm({
    fields: ledgerEntryAddFields(options),
  });
