import { t } from "#i18n";
import type { ManualLedgerEntryOption } from "#shared/accounting/manual-entries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { ConfirmForm, CsrfForm, hiddenInputs } from "#shared/forms.tsx";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import type { AdminSession } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { humanDescription } from "#templates/admin/ledger/formatting.tsx";
import {
  accountCellFor,
  accountLabelText,
  type LedgerNames,
} from "#templates/admin/ledger.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { PriceInput } from "#templates/components/price-input.tsx";

export type LedgerEntryFormValues = {
  amount: string;
  occurredAt: string;
  entryType?: string | undefined;
};

export type LedgerEntryAddOption = ManualLedgerEntryOption & {
  label: string;
  hint: string;
};

type LedgerEntryPageData = {
  error?: string | undefined;
  names: LedgerNames;
  returnUrl: string;
  session: AdminSession;
  values: LedgerEntryFormValues;
};

const LedgerEntryFields = ({
  values,
}: {
  values: LedgerEntryFormValues;
}): JSX.Element => (
  <>
    <label>
      {t("admin.ledger.form.amount")}
      <PriceInput min="0" name="amount" required value={values.amount} />
    </label>
    <label>
      {t("admin.ledger.form.occurred_at")}
      <input
        name="occurred_at"
        required
        type="datetime-local"
        value={values.occurredAt}
      />
    </label>
  </>
);

const LedgerEntryCancel = ({
  returnUrl,
}: {
  returnUrl: string;
}): JSX.Element => (
  <p>
    <ActionButton href={returnUrl} variant="secondary">
      {t("common.cancel")}
    </ActionButton>
  </p>
);

export const adminLedgerEntryAddPage = ({
  account,
  names,
  options,
  values,
  returnUrl,
  session,
  error,
}: LedgerEntryPageData & {
  account: AccountRef;
  options: LedgerEntryAddOption[];
}): string =>
  errorAdminPage(t("admin.ledger.add.heading"), "/admin/ledger")(
    session,
    error,
  )(
    <CsrfForm action={`/admin/ledger/${account.type}/${account.id}/add`}>
      <h1>{t("admin.ledger.add.heading")}</h1>
      <p>
        {t("admin.ledger.add.account")}{" "}
        <strong>{accountLabelText(account, names)}</strong>
      </p>
      {hiddenInputs([["return_url", returnUrl]])}
      <label>
        {t("admin.ledger.add.type")}
        <select name="entry_type" required>
          {options.map((option) => (
            <option
              selected={values.entryType === option.type}
              value={option.type}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <ul>
        {options.map((option) => (
          <li>
            <strong>{option.label}:</strong> {option.hint}
          </li>
        ))}
      </ul>
      <LedgerEntryFields values={values} />
      <SubmitButton icon="plus">{t("admin.ledger.add.submit")}</SubmitButton>
      <LedgerEntryCancel returnUrl={returnUrl} />
    </CsrfForm>,
  );

export const adminLedgerEntryEditPage = ({
  transfer,
  names,
  values,
  returnUrl,
  session,
  error,
}: LedgerEntryPageData & {
  transfer: Transfer;
}): string =>
  errorAdminPage(t("admin.ledger.edit.heading"), "/admin/ledger")(
    session,
    error,
  )(
    <>
      <h1>{t("admin.ledger.edit.heading")}</h1>
      <p>{humanDescription(transfer, accountCellFor(names))}</p>
      <CsrfForm action={`/admin/ledger/entries/${transfer.id}/edit`}>
        {hiddenInputs([["return_url", returnUrl]])}
        <LedgerEntryFields values={values} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>
      <ConfirmForm
        action={`/admin/ledger/entries/${transfer.id}/delete`}
        buttonText={t("admin.ledger.delete.submit")}
        label={t("admin.ledger.delete.label")}
        name={formatCurrency(transfer.amount)}
        returnUrl={returnUrl}
      >
        <h2>{t("admin.ledger.delete.heading")}</h2>
        <p>{t("admin.ledger.delete.warning")}</p>
        <p>
          {t("admin.ledger.delete.confirm_prompt", {
            amount: formatCurrency(transfer.amount),
          })}
        </p>
      </ConfirmForm>
      <LedgerEntryCancel returnUrl={returnUrl} />
    </>,
  );
